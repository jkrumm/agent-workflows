import { parseJsonLoose } from '@agent-workflows/capabilities'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import { type Ctx, defineWorkflow, type Json, type Usage, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { createEngineClient, type EngineClient, EngineReport, engineEndpoint, runEngineJob } from './engine.ts'
import {
  type CapabilityCall,
  evidence,
  type GateTool,
  type GrantRecord,
  normalizeUrl,
  ToolGate,
  toolCounts,
} from './gate.ts'
import { JSON_ONLY_REASK, researchTask } from './prompts.ts'
import {
  type Depth,
  type Design,
  Draft,
  type Profile,
  ResearchInput,
  ResearchOutput,
  type ResearchResult,
} from './schema.ts'
import { researchScorer } from './scorer.ts'

export const RESEARCH_VERSION = '2026-10-28.1'

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
  enginePollMs?: number
}

const zeroTokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 }

/** The engine's own spend as one usage report: its `cost.totalUsd` (LLM and search), unpriced when it has none. */
export function engineUsage(costUsd: number | null | undefined): Usage {
  const priced = typeof costUsd === 'number' && Number.isFinite(costUsd)
  return {
    model: 'research-gateway',
    tokens: zeroTokens,
    cost: priced ? costUsd : null,
    costSource: priced ? 'provider' : 'unknown',
  }
}

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
export function assemble(draft: Draft, rec: GrantRecord, arm: { design: Design; profile: Profile }): ResearchResult {
  const { retrieved, seen, failed } = evidence(rec)
  const known = (url: string) => retrieved.has(normalizeUrl(url)) || seen.has(normalizeUrl(url))
  const kept = draft.citations.filter((c) => known(c.url))
  const dropped = draft.citations.filter((c) => !known(c.url))
  const warnings: string[] = []
  if (dropped.length) warnings.push(`${dropped.length} citation(s) dropped: their URL was never retrieved this run`)
  const noPages = retrieved.size === 0 && seen.size === 0
  if (noPages) warnings.push('nothing was retrieved this run')
  const partial =
    noPages || (draft.citations.length > 0 && dropped.length / draft.citations.length >= PARTIAL_DROP_SHARE)
  const sources = [...new Set([...draft.sources.filter(known), ...rec.entries.flatMap((e) => e.retrieved)])]
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
      pagesFailed: failed,
    },
    arm,
    tools: toolCounts(rec),
    ...(rec.engineJobs.length ? { engine: { jobs: rec.engineJobs, costUsd: rec.engineCostUsd } } : {}),
  }
}

/** The draft from an agent's text answer, or null when it is not the JSON object. */
function parseDraft(text: string): Draft | null {
  const parsed = Draft.safeParse(parseJsonLoose(text))
  return parsed.success ? parsed.data : null
}

/** The recorded part of a grant: plain JSON for the journal. */
const GrantJson = z.object({
  entries: z.array(
    z.object({
      tool: z.string(),
      ok: z.boolean(),
      retrieved: z.array(z.string()),
      seen: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
  engineJobs: z.array(z.string()),
  engineCostUsd: z.number().nullable(),
})

export function createResearchWorkflows(deps: WorkflowDeps, options: ResearchOptions = {}): HostWorkflow[] {
  const env = options.env ?? process.env
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  const engine = (): EngineClient | null => {
    if (options.engine !== undefined) return options.engine
    const endpoint = engineEndpoint(env, stateDir)
    return endpoint ? createEngineClient(endpoint) : null
  }
  // The web capabilities are called by id: the registry's typed ids grow as capabilities land (`web.*`, Wave 6).
  const registry = deps.registry as unknown as { call: CapabilityCall }
  const gate =
    options.gate ??
    new ToolGate({
      stateDir,
      engine,
      call: (id, input, scope) => registry.call(id, input, scope),
      ...(options.enginePollMs ? { enginePollMs: options.enginePollMs } : {}),
    })
  const pollMs = options.enginePollMs

  async function runEngine(ctx: Ctx, input: z.output<typeof ResearchInput>): Promise<ResearchResult> {
    const client = engine()
    if (!client) throw new WorkflowError('error', 'no research engine is configured (AGW_RESEARCH_ENGINE_URL)')
    const out = await ctx.step('engine', async ({ key, signal, progress, addUsage }) => {
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
    const stepKey = `${ctx.runId}:research`
    const close = gate.open({
      runId: ctx.runId,
      stepKey,
      depth: input.depth,
      tools: ARM_TOOLS[design][profile],
    })
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
    // What the tools collected and cost, journaled: a replay reads it from here, never from the in-memory gate.
    const recorded = await ctx.step('evidence', ({ addUsage }) => {
      const rec = gate.take(stepKey)
      for (const usage of rec.usage) addUsage(usage)
      return { entries: rec.entries, engineJobs: rec.engineJobs, engineCostUsd: rec.engineCostUsd }
    })
    if (failure) throw failure
    if (!draft) throw new WorkflowError('invalid_output', 'the research agent did not answer with the report JSON')
    const rec = GrantJson.parse(recorded)
    return assemble(draft, { ...rec, entries: rec.entries as GrantRecord['entries'], usage: [] }, { design, profile })
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
