import { parseJsonLoose } from '@agent-workflows/capabilities'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import { type Ctx, defineWorkflow, type Json, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { type CapabilityCall, evidence, GATE_TOOLS, normalizeUrl, ToolGate } from './gate.ts'
import { memoryToolLedger, type ToolLedger } from './ledger.ts'
import { type EarlierResearch, JSON_ONLY_REASK, researchTask } from './prompts.ts'
import { Citation, Draft, ResearchInput, ResearchOutput, type ResearchResult } from './schema.ts'
import { researchScorer } from './scorer.ts'

export const RESEARCH_VERSION = '2026-10-29.1'

/** The agent's definition (`agents/research`) allows exactly the gate's tools. */
const AGENT = 'research'

/** A citation share at or above this dropped for lack of a retrieved page makes the report `partial`. */
const PARTIAL_DROP_SHARE = 0.1

export type ResearchOptions = {
  stateDir?: string
  gate?: ToolGate
  /** Where the gate records every call; default the host's (`deps.research.ledger`), else in memory. */
  ledger?: ToolLedger
  /** Wait before the agent step's second attempt. Default 1 s. */
  agentBackoffMs?: number
}

/** One retry of the agent step: a flaky attempt (a died session, an idle kill) must not decide the run. */
const AGENT_ATTEMPTS = 2

/** What the `tools` step journals: the evidence of the step's recorded tool calls, summed. */
export const Evidence = z.object({
  retrieved: z.array(z.string()),
  seen: z.array(z.string()),
  failed: z.number().int(),
  counts: z.record(z.string(), z.number().int()),
  calls: z.number().int(),
})
export type Evidence = z.output<typeof Evidence>

/** What the `followup` step journals: the finished run a follow-up continues, or why it cannot. */
const Followed = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    question: z.string(),
    report: z.string(),
    citations: z.array(Citation),
    retrieved: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

/**
 * An agent's draft against what its tools retrieved: a citation whose URL the run never retrieved nor saw as a
 * search result is dropped and restated in `unverified`; dropping 10 % or more, or retrieving nothing at all, makes
 * the report `partial`. `grounding` counts before the drop. `earlier` is what a follow-up may also rest on (the pages
 * its earlier run retrieved and the URLs of that run's final citations): a citation of one is grounded, but they are
 * not this run's retrievals and are not counted.
 */
export function assemble(draft: Draft, ev: Evidence, earlier: readonly string[] = []): ResearchResult {
  const retrieved = new Set(ev.retrieved)
  const seen = new Set(ev.seen)
  const before = new Set(earlier.map(normalizeUrl))
  const known = (url: string) => {
    const key = normalizeUrl(url)
    return retrieved.has(key) || seen.has(key) || before.has(key)
  }
  const kept = draft.citations.filter((c) => known(c.url))
  const dropped = draft.citations.filter((c) => !known(c.url))
  const warnings: string[] = []
  if (dropped.length) warnings.push(`${dropped.length} citation(s) dropped: their URL was never retrieved this run`)
  const noPages = retrieved.size === 0 && seen.size === 0 && before.size === 0
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
      citations: draft.citations.length,
      grounded: kept.length,
      pagesRetrieved: retrieved.size,
      pagesFailed: ev.failed,
    },
    tools: ev.counts,
  }
}

/** The draft from an agent's text answer, or null when it is not the JSON object. */
function parseDraft(text: string): Draft | null {
  const parsed = Draft.safeParse(parseJsonLoose(text))
  return parsed.success ? parsed.data : null
}

/** `done`, or the signal's reason once it aborts; the listener goes with it, and none is added when already aborted. */
async function untilAborted(done: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([done, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createResearchWorkflows(deps: WorkflowDeps, options: ResearchOptions = {}): HostWorkflow[] {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  // The gate calls `web.*` by a string id from its tool map (`gate.ts` CAPABILITY), so the typed ids are widened here.
  const registry = deps.registry as unknown as { call: CapabilityCall }
  const ledger = options.ledger ?? deps.research?.ledger ?? memoryToolLedger()
  const gate =
    options.gate ??
    new ToolGate({
      stateDir,
      ledger,
      call: (id, input, scope) => registry.call(id, input, scope),
    })
  deps.onClose?.(() => gate.close())

  /**
   * The finished research run a follow-up continues: its question, report and citations, and the URLs a new citation
   * may rest on: the pages its tools retrieved (its ledger rows) and the URLs of its final citations, which passed its
   * own grounding (a search result it saw, a page its own earlier run retrieved), so a chain of follow-ups stays
   * grounded. Journaled as a step, so a resumed run sees the same context. Anything else than a `done` research run is
   * `invalid_input`.
   */
  async function loadEarlier(ctx: Ctx, runId: string): Promise<EarlierResearch> {
    const out = await ctx.step('followup', async (): Promise<Json> => {
      if (!ledger.hasJournal) return { ok: false, reason: 'this host keeps no run journal' }
      const run = await ledger.run(runId)
      if (!run) return { ok: false, reason: `run ${runId} does not exist` }
      if (run.workflow !== 'research')
        return { ok: false, reason: `run ${runId} is a ${run.workflow} run, not research` }
      if (run.status !== 'done') return { ok: false, reason: `run ${runId} is ${run.status}, not done` }
      const input = z.object({ query: z.string() }).safeParse(run.input)
      const output = ResearchOutput.safeParse(run.output)
      if (!input.success || !output.success) return { ok: false, reason: `run ${runId} holds no research report` }
      const { report, citations } = output.data
      const retrieved = [...evidence(await ledger.read(runId, 'research')).retrieved]
      const have = new Set(retrieved)
      for (const { url } of citations) {
        if (have.has(normalizeUrl(url))) continue
        have.add(normalizeUrl(url))
        retrieved.push(url)
      }
      return { ok: true, question: input.data.query, report, citations, retrieved }
    })
    const followed = Followed.parse(out)
    if (!followed.ok) throw new WorkflowError('invalid_input', `cannot follow up: ${followed.reason}`)
    const { question, report, citations, retrieved } = followed
    return { question, report, citations, retrieved }
  }

  async function runAgent(ctx: Ctx, input: z.output<typeof ResearchInput>): Promise<ResearchResult> {
    const runId = ctx.runId
    const followed = input.followUp ? await loadEarlier(ctx, input.followUp) : undefined
    const close = gate.open({ runId, stepId: 'research', tools: GATE_TOOLS })
    let agentEnded!: () => void
    const ended = new Promise<void>((resolve) => {
      agentEnded = resolve
    })
    // The one teardown, from wherever the run leaves first: the agent has ended, so its calls in flight are served
    // (bounded; not on a cancel) and the grant closes, a late call refused. Idempotent: later callers await the same.
    let teardown: Promise<void> | undefined
    const endAgent = (drain = !ctx.signal.aborted) => {
      agentEnded()
      teardown ??= (drain ? gate.settle(runId, 'research') : Promise.resolve()).then(close)
      return teardown
    }
    let toolsBound!: () => void
    const bound = new Promise<void>((resolve) => {
      toolsBound = resolve
    })
    // The grant is closed on every path out, the early ones included (the tools step failing before it binds).
    try {
      // The tools step lives as long as the agent's turns: every gate call books its usage here as it is reported, so
      // a cancelled or failed run keeps its spend (the step records its usage whatever its end). Its output is the
      // evidence from the ledger, read once the agent has ended and every call in flight is served.
      const tools = ctx.step('tools', async ({ addUsage, signal }) => {
        const unbind = gate.bindUsage(runId, 'research', addUsage)
        toolsBound()
        try {
          await untilAborted(ended, signal)
        } finally {
          // The grant ends before the step does: a late call is refused, and every booked usage is on this step.
          await endAgent(!signal.aborted)
          unbind()
        }
        const entries = await ledger.read(runId, 'research')
        const ev = evidence(entries)
        return {
          retrieved: [...ev.retrieved],
          seen: [...ev.seen],
          failed: ev.failed,
          counts: ev.counts,
          calls: entries.length,
        } satisfies Evidence
      })
      tools.catch(() => {}) // awaited below; a rejection before that is not unhandled
      // A replayed tools step never runs its body: the step itself resolves.
      await Promise.race([bound, tools.then(() => {})])

      let draft: Draft | null = null
      let failure: unknown = null
      try {
        const prompt = researchTask({
          query: input.query,
          depth: input.depth,
          ...(input.context ? { context: input.context } : {}),
          ...(followed ? { earlier: followed } : {}),
        })
        const text = await ctx.agent('research', {
          agent: AGENT,
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
        await endAgent()
      }
      const recorded = await tools
      if (failure) throw failure
      if (!draft) throw new WorkflowError('invalid_output', 'the research agent did not answer with the report JSON')
      return assemble(draft, Evidence.parse(recorded), followed?.retrieved)
    } finally {
      await endAgent()
    }
  }

  const research = defineWorkflow({
    id: 'research',
    version: RESEARCH_VERSION,
    input: ResearchInput,
    output: ResearchOutput,
    scorer: researchScorer,
    run: runAgent,
  })

  return [
    {
      workflow: research,
      summary:
        'Research a question into a cited report; with --follow-up, continue a finished report with a new question',
      cli: { positional: ['query'], defaultFormat: 'json' },
      agents: [{ agent: AGENT, route: 'research.agent' }],
    },
  ]
}
