import { parseJsonLoose } from '@agent-workflows/capabilities'
import { type Ctx, defineWorkflow, type Logger, type Usage, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { HostDeps } from '../index.ts'
import { memoryToolLedger, type ToolLedger } from '../research/ledger.ts'
import { brainTask, JSON_ONLY_REASK } from './prompts.ts'
import { BrainInput, BrainOutput, type BrainResult, Draft } from './schema.ts'
import { brainScorer } from './scorer.ts'
import { brainGrant, evidence, foldPath } from './tools.ts'

export const BRAIN_VERSION = '2026-10-29.1'

/** The agent's definition (`agents/brain`) allows exactly the gate's two tools. */
const AGENT = 'brain'

export type BrainOptions = {
  /** Where the gate records every call; default the host's (`deps.research.ledger`, the one table), else in memory. */
  ledger?: ToolLedger
  /** Where a failed ledger write is logged; default `deps.logger`. */
  logger?: Logger
  /** Wait before the second attempt. Default 1 s. */
  agentBackoffMs?: number
}

/** What the `tools` step journals: the notes the run read and the calls it made. */
export const Evidence = z.object({
  read: z.array(z.string()),
  counts: z.record(z.string(), z.number().int()),
  calls: z.number().int(),
})
export type Evidence = z.output<typeof Evidence>

/**
 * An agent's draft against the notes its tools opened in the attempt that produced it: a citation of a note that attempt
 * did not read (invented, mistyped, refused, only seen in a search hit, or read by an earlier attempt that died) is
 * dropped into `warnings`. Paths are compared NFC-normalised and case-folded, and a kept citation carries the canonical
 * path the tool printed. `notfound` is the agent's own verdict that the vault does not answer; anything answered is
 * `partial` when a citation was dropped, none was grounded, or nothing was read. `grounding` counts before the drop.
 */
export function assemble(draft: Draft, ev: Pick<Evidence, 'read'>): BrainResult {
  const read = new Map(ev.read.map((path) => [foldPath(path), path]))
  const cited = draft.citations.map((c) => ({ path: c.path, claim: c.claim, read: read.get(foldPath(c.path)) }))
  const kept = cited.flatMap((c) => (c.read === undefined ? [] : [{ path: c.read, claim: c.claim }]))
  const dropped = cited.length - kept.length
  const warnings: string[] = []
  if (dropped) warnings.push(`${dropped} citation(s) dropped: the note was not read this run`)
  let status: BrainResult['status'] = 'ok'
  if (!draft.found) status = 'notfound'
  else {
    if (ev.read.length === 0) warnings.push('nothing was read this run')
    else if (kept.length === 0) warnings.push('the answer cites no note it read')
    if (dropped || kept.length === 0) status = 'partial'
  }
  return {
    answer: draft.answer,
    citations: kept,
    read: ev.read,
    status,
    warnings,
    grounding: { citations: cited.length, grounded: kept.length },
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

/** What a step body is given by `ctx.step`: the part of its scope the tools step uses. */
type ToolsBody = (scope: { addUsage: (usage: Usage) => void; signal: AbortSignal }) => Promise<Evidence>

/**
 * One try of the agent, as its own agent step with its own grant and evidence: `stepId` is the agent step's id, the
 * gate's grant key and the ledger's step. The ids are written out at the call sites (step ids are literals), so the
 * attempt arrives as closures over them.
 */
type Attempt = {
  stepId: string
  tools: (body: ToolsBody) => Promise<Evidence>
  agent: () => Promise<string>
  reask: () => Promise<string>
}

/**
 * The `brain` workflow: read-only Q&A over the vault. Another workflow runs it as a child with
 * `ctx.workflow('<step>', brain, [{ question }])`, where `brain` is `createBrainWorkflows(deps)[0].workflow`; a child
 * that fails comes back `null`. Input `{question}` and output `{answer, citations, read, status, warnings, grounding}`
 * are the contract (`schema.ts`); a change to either bumps `BRAIN_VERSION` and its callers.
 *
 * **Grounding per attempt.** A failed agent step is tried once more, as a second step (`brain:retry`) with a grant and
 * a ledger step of its own, and the answer is grounded on the evidence of the attempt that produced it: a note the
 * first attempt read before it died grounds nothing in the second.
 */
export function createBrainWorkflows(deps: HostDeps, options: BrainOptions = {}): HostWorkflow[] {
  const ledger = options.ledger ?? deps.research?.ledger ?? memoryToolLedger()
  const grant = brainGrant(ledger, options.logger ?? deps.logger)
  const toolGate = deps.toolGate

  /** Runs one attempt under its grant: the draft (null when the answer was not the JSON, even after the re-ask) and the notes it read. */
  async function runAttempt(ctx: Ctx, attempt: Attempt): Promise<{ draft: Draft | null; ev: Evidence }> {
    const { stepId } = attempt
    const runId = ctx.runId
    const close = toolGate.open({ runId, stepId, ...grant })
    let agentEnded!: () => void
    const ended = new Promise<void>((resolve) => {
      agentEnded = resolve
    })
    // The one teardown, from wherever the attempt leaves first: the agent has ended, so its calls in flight are served
    // (bounded; not on a cancel) and the grant closes, a late call refused. Idempotent: later callers await the same.
    let teardown: Promise<void> | undefined
    const endAgent = (drain = !ctx.signal.aborted) => {
      agentEnded()
      teardown ??= (drain ? toolGate.settle(runId, stepId) : Promise.resolve()).then(close)
      return teardown
    }
    let toolsBound!: () => void
    const bound = new Promise<void>((resolve) => {
      toolsBound = resolve
    })
    // The grant is closed on every path out, the early ones included (the tools step failing before it binds).
    try {
      // The tools step lives as long as the agent's turns: every gate call books its usage here as it is reported, so
      // a cancelled or failed attempt keeps its spend. Its output is the evidence from the ledger, read once the agent
      // has ended and every call in flight is served.
      const tools = attempt.tools(async ({ addUsage, signal }) => {
        const unbind = toolGate.bindUsage(runId, stepId, addUsage)
        toolsBound()
        try {
          await untilAborted(ended, signal)
        } finally {
          // The grant ends before the step does: a late call is refused, and every booked usage is on this step.
          await endAgent(!signal.aborted)
          unbind()
        }
        const entries = await ledger.read(runId, stepId)
        const { read, counts } = evidence(entries)
        return { read, counts, calls: entries.length } satisfies Evidence
      })
      tools.catch(() => {}) // awaited below; a rejection before that is not unhandled
      // A replayed tools step never runs its body: the step itself resolves.
      await Promise.race([bound, tools.then(() => {})])

      let draft: Draft | null = null
      let failure: unknown = null
      try {
        draft = parseDraft(await attempt.agent())
        // One re-ask in the same session (concept §4: one re-ask, then invalid_output).
        if (!draft) draft = parseDraft(await attempt.reask())
      } catch (error) {
        failure = error
      } finally {
        await endAgent()
      }
      const recorded = await tools
      if (failure) throw failure
      return { draft, ev: Evidence.parse(recorded) }
    } finally {
      await endAgent()
    }
  }

  async function runBrain(ctx: Ctx, input: z.output<typeof BrainInput>): Promise<BrainResult> {
    const prompt = brainTask(input.question)
    const spec = { agent: AGENT, prompt, output: z.string(), options: { output: 'text' } } as const
    let outcome: Awaited<ReturnType<typeof runAttempt>>
    try {
      outcome = await runAttempt(ctx, {
        stepId: 'brain',
        tools: (body) => ctx.step('tools', body),
        agent: () => ctx.agent('brain', spec),
        reask: () => ctx.continue('brain:reask', 'brain', JSON_ONLY_REASK, { output: z.string() }),
      })
    } catch (error) {
      // A flaky attempt (a died session, an idle kill) must not decide the run; a cancel does.
      if (ctx.signal.aborted) throw error
      await Bun.sleep(options.agentBackoffMs ?? 1_000)
      outcome = await runAttempt(ctx, {
        stepId: 'brain:retry',
        tools: (body) => ctx.step('tools:retry', body),
        agent: () => ctx.agent('brain:retry', spec),
        reask: () => ctx.continue('brain:retry:reask', 'brain:retry', JSON_ONLY_REASK, { output: z.string() }),
      })
    }
    if (!outcome.draft) throw new WorkflowError('invalid_output', 'the brain agent did not answer with the answer JSON')
    return assemble(outcome.draft, outcome.ev)
  }

  const brain = defineWorkflow({
    id: 'brain',
    version: BRAIN_VERSION,
    input: BrainInput,
    output: BrainOutput,
    scorer: brainScorer,
    run: runBrain,
  })

  return [
    {
      workflow: brain,
      summary: "Answer a question from the owner's vault, read-only, with citations to the notes it read",
      cli: { positional: ['question'], defaultFormat: 'json' },
      agents: [{ agent: AGENT, route: 'brain.agent' }],
    },
  ]
}
