import { parseJsonLoose } from '@agent-workflows/capabilities'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import { type Ctx, defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import {
  createEngineClient,
  type EngineClient,
  EngineJobFailed,
  EngineReport,
  engineEndpoint,
  runEngineJob,
} from './engine.ts'
import { type CapabilityCall, engineUsage, evidence, type GateTool, normalizeUrl, ToolGate } from './gate.ts'
import { memoryToolLedger, type ToolLedger } from './ledger.ts'
import { JSON_ONLY_REASK, researchTask } from './prompts.ts'
import { type Design, Draft, type Profile, ResearchInput, ResearchOutput, type ResearchResult } from './schema.ts'
import { researchScorer } from './scorer.ts'

export const RESEARCH_VERSION = '2026-10-28.2'

/** The tools each agent arm is granted; its agent definition allows exactly these (`agents/research-*`). */
export const ARM_TOOLS: Record<Exclude<Design, 'engine'>, Record<Profile, GateTool[]>> = {
  agent: { yolo: ['web_search', 'web_fetch', 'web_docs', 'web_package'], focused: ['web_search', 'web_fetch'] },
  pilot: {
    yolo: ['engine_research', 'web_search', 'web_fetch', 'web_docs', 'web_package'],
    focused: ['engine_research'],
  },
}

/** A citation share at or above this dropped for lack of a retrieved page makes the report `partial` (the engine's rule). */
const PARTIAL_DROP_SHARE = 0.1

const AGENTS = (['agent', 'pilot'] as const).flatMap((design) =>
  (['yolo', 'focused'] as const).map((profile) => ({
    agent: `research-${design}-${profile}`,
    route: 'research.agent' as const,
  })),
)

export type ResearchOptions = {
  env?: Record<string, string | undefined>
  stateDir?: string
  /** The engine; default from `AGW_RESEARCH_ENGINE_URL`/`_TOKEN` or `<stateDir>/research/engine.json`. */
  engine?: EngineClient | null
  gate?: ToolGate
  /** Where the gate records every call; default the host's (`deps.research.ledger`), else in memory. */
  ledger?: ToolLedger
  enginePollMs?: number
  /** Wait before the agent step's second attempt. Default 1 s. */
  agentBackoffMs?: number
}

/** One retry of the agent step: a flaky attempt (a died session, an idle kill) must not decide the run. */
const AGENT_ATTEMPTS = 2

/** What the `evidence` step journals: the step's recorded tool calls, summed. */
export const Evidence = z.object({
  retrieved: z.array(z.string()),
  seen: z.array(z.string()),
  failed: z.number().int(),
  counts: z.record(z.string(), z.number().int()),
  engineJobs: z.array(z.string()),
  engineCostUsd: z.number().nullable(),
  calls: z.number().int(),
})
export type Evidence = z.output<typeof Evidence>

/** The engine's report in the platform's shape; its grounding ledger says how many citations it kept and dropped. */
export function fromEngine(jobId: string, report: EngineReport): ResearchResult {
  const g = report.grounding
  const citations = g ? g.citationsKept + g.citationsDropped : report.citations.length
  return {
    report: report.report,
    citations: report.citations,
    sources: report.sources,
    unverified: report.unverified,
    status: report.status,
    warnings: report.warnings,
    grounding: {
      source: 'engine',
      citations,
      grounded: g ? g.citationsKept : report.citations.length,
      pagesRetrieved: g?.pagesRetrieved ?? 0,
      pagesFailed: g?.pagesFailed ?? 0,
    },
    arm: { design: 'engine', profile: null },
    engine: { jobs: [jobId], costUsd: report.cost?.totalUsd ?? null },
  }
}

/**
 * An agent's draft against what its tools retrieved, the engine's grounding rule in code: a citation whose URL the
 * run never retrieved nor saw as a search result is dropped and restated in `unverified`; dropping 10 % or more, or
 * retrieving nothing at all, makes the report `partial`. `grounding` counts before the drop.
 */
export function assemble(draft: Draft, ev: Evidence, arm: { design: Design; profile: Profile }): ResearchResult {
  const retrieved = new Set(ev.retrieved)
  const seen = new Set(ev.seen)
  const known = (url: string) => retrieved.has(normalizeUrl(url)) || seen.has(normalizeUrl(url))
  const kept = draft.citations.filter((c) => known(c.url))
  const dropped = draft.citations.filter((c) => !known(c.url))
  const warnings: string[] = []
  if (dropped.length) warnings.push(`${dropped.length} citation(s) dropped: their URL was never retrieved this run`)
  const noPages = retrieved.size === 0 && seen.size === 0
  if (noPages) warnings.push('nothing was retrieved this run')
  const partial =
    noPages || (draft.citations.length > 0 && dropped.length / draft.citations.length >= PARTIAL_DROP_SHARE)
  const sources = [...new Set([...draft.sources.filter(known), ...ev.retrieved])]
  return {
    report: draft.report,
    citations: kept,
    sources,
    unverified: [
      ...draft.unverified,
      ...dropped.map((c) => ({
        topic: c.claim,
        url: c.url,
        reason: 'cited, but the page was never retrieved this run',
      })),
    ],
    status: partial ? 'partial' : 'ok',
    warnings,
    grounding: {
      source: 'tools',
      citations: draft.citations.length,
      grounded: kept.length,
      pagesRetrieved: retrieved.size,
      pagesFailed: ev.failed,
    },
    arm,
    tools: ev.counts,
    ...(ev.engineJobs.length ? { engine: { jobs: ev.engineJobs, costUsd: ev.engineCostUsd } } : {}),
  }
}

/** The draft from an agent's text answer, or null when it is not the JSON object. */
function parseDraft(text: string): Draft | null {
  const parsed = Draft.safeParse(parseJsonLoose(text))
  return parsed.success ? parsed.data : null
}

export function createResearchWorkflows(deps: WorkflowDeps, options: ResearchOptions = {}): HostWorkflow[] {
  const env = options.env ?? process.env
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  const engine = (): EngineClient | null => {
    if (options.engine !== undefined) return options.engine
    const endpoint = engineEndpoint(env, stateDir)
    return endpoint ? createEngineClient(endpoint) : null
  }
  // The gate calls `web.*` by a string id from its tool map (`gate.ts` CAPABILITY), so the typed ids are widened here.
  const registry = deps.registry as unknown as { call: CapabilityCall }
  const ledger = options.ledger ?? deps.research?.ledger ?? memoryToolLedger()
  const gate =
    options.gate ??
    new ToolGate({
      stateDir,
      engine,
      ledger,
      call: (id, input, scope) => registry.call(id, input, scope),
      ...(options.enginePollMs ? { enginePollMs: options.enginePollMs } : {}),
    })
  deps.onClose?.(() => gate.close())
  const pollMs = options.enginePollMs

  async function runEngine(ctx: Ctx, input: z.output<typeof ResearchInput>): Promise<ResearchResult> {
    const client = engine()
    if (!client) throw new WorkflowError('error', 'no research engine is configured (AGW_RESEARCH_ENGINE_URL)')
    const out = await ctx.step('engine', async ({ key, signal, progress, addUsage }) => {
      try {
        const { jobId, report } = await runEngineJob(
          client,
          {
            query: input.query,
            depth: input.depth,
            ...(input.context ? { context: input.context } : {}),
            idempotencyKey: key,
          },
          { signal, progress, ...(pollMs ? { pollMs } : {}) },
        )
        addUsage(engineUsage(report.cost?.totalUsd))
        return { jobId, report }
      } catch (error) {
        // A failed job still cost what the engine says it cost, or an unknown amount: never 0.
        if (error instanceof EngineJobFailed) addUsage(engineUsage(error.costUsd))
        throw error
      }
    })
    const { jobId, report } = z.object({ jobId: z.string(), report: EngineReport }).parse(out)
    return fromEngine(jobId, report)
  }

  async function runAgent(
    ctx: Ctx,
    input: z.output<typeof ResearchInput>,
    design: Exclude<Design, 'engine'>,
  ): Promise<ResearchResult> {
    const { profile } = input
    const close = gate.open({ runId: ctx.runId, stepId: 'research', tools: ARM_TOOLS[design][profile] })
    let draft: Draft | null = null
    let failure: unknown = null
    try {
      const prompt = researchTask({
        query: input.query,
        depth: input.depth,
        design,
        ...(input.context ? { context: input.context } : {}),
      })
      const text = await ctx.agent('research', {
        agent: `research-${design}-${profile}`,
        prompt,
        output: z.string(),
        options: { output: 'text' },
        retry: { attempts: AGENT_ATTEMPTS, backoffMs: options.agentBackoffMs ?? 1_000 },
      })
      draft = parseDraft(text)
      // One re-ask in the same session (concept §4: one re-ask, then invalid_output).
      if (!draft)
        draft = parseDraft(await ctx.continue('research:reask', 'research', JSON_ONLY_REASK, { output: z.string() }))
    } catch (error) {
      failure = error
    } finally {
      close()
    }
    // A cancel or shutdown unwinds at once; a failed agent step still records what its tools cost.
    if (failure && ctx.signal.aborted) throw failure
    // What the tools did and cost, read from the ledger (never consumed: a retry or a resume reads the same calls).
    const recorded = await ctx.step('evidence', async ({ addUsage }) => {
      const entries = await ledger.read(ctx.runId, 'research')
      for (const entry of entries) for (const usage of entry.usage) addUsage(usage)
      const ev = evidence(entries)
      return {
        retrieved: [...ev.retrieved],
        seen: [...ev.seen],
        failed: ev.failed,
        counts: ev.counts,
        engineJobs: ev.engineJobs,
        engineCostUsd: ev.engineCostUsd,
        calls: entries.length,
      } satisfies Evidence
    })
    if (failure) throw failure
    if (!draft) throw new WorkflowError('invalid_output', 'the research agent did not answer with the report JSON')
    return assemble(draft, Evidence.parse(recorded), { design, profile })
  }

  const research = defineWorkflow({
    id: 'research',
    version: RESEARCH_VERSION,
    input: ResearchInput,
    output: ResearchOutput,
    scorer: researchScorer,
    async run(ctx, input) {
      return input.design === 'engine' ? runEngine(ctx, input) : runAgent(ctx, input, input.design)
    },
  })

  return [
    {
      workflow: research,
      summary: 'Research a question into a cited report (Wave 6: engine, agent or pilot design)',
      cli: { positional: ['query'], defaultFormat: 'json' },
      agents: AGENTS,
    },
  ]
}
