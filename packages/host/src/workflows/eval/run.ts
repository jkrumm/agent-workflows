import { homedir } from 'node:os'
import { cleanup, exec as bunExec, type Exec, materialize, pool } from '@agent-workflows/eval'
import { Cancelled, defineWorkflow, IdempotencyConflict, type Json, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { EvalSlot } from './slot.ts'
import { type EvalCase, readSuite, SUITE_IDS, type SuiteId } from './suites.ts'

export const EVAL_RUN_ID = 'eval.run'
/** Estimates read the latest this many done runs of the workflow. */
const ESTIMATE_HISTORY = 50
const DEFAULT_CONCURRENCY = 2

export interface EvalRunOptions {
  env?: Record<string, string | undefined>
  exec?: Exec
  /** Where materialized clones go. Default: the OS temp dir. */
  tmpRoot?: string
}

/** Plain JSON from the wire; the runtime refuses anything else on the run input. */
export const JsonRecord = z.record(z.string(), z.unknown()) as unknown as z.ZodType<Record<string, Json>>

export const EvalRunInput = z
  .object({
    workflow: z.enum(SUITE_IDS).describe('The workflow to replay its recorded cases against'),
    ids: z.string().optional().describe('Comma-separated case ids (first), then --limit; an unknown id is an error'),
    limit: z.number().int().positive().optional().describe('Only the first N selected cases'),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe(`Cases in flight at once, default ${DEFAULT_CONCURRENCY} (IU rate limits, host load)`),
    args: JsonRecord.optional().describe(
      'Extra workflow input for every case, the experiment arm, e.g. {"angleVariant":"shell"}; kept with each score for `agw eval compare --a-args/--b-args`',
    ),
    yes: z
      .boolean()
      .optional()
      .describe('Run the cases: spends IU money. Without it, only the plan and a cost estimate; nothing runs'),
  })
  .strict()

const CaseResult = z.object({
  caseId: z.string(),
  status: z.enum(['scored', 'skipped', 'error']),
  runId: z.string().optional(),
  runStatus: z.string().optional(),
  fingerprint: z.string().nullable().optional(),
  pass: z.boolean().optional(),
  scores: z.record(z.string(), z.number()).optional(),
  reason: z.string().optional(),
})
type CaseResult = z.infer<typeof CaseResult>

export const EvalRunOutput = z.object({
  workflow: z.enum(SUITE_IDS),
  ran: z.boolean().describe('False: the plan only (no --yes)'),
  args: JsonRecord,
  plan: z.object({
    ids: z.array(z.string()),
    estimate: z.object({
      historyRuns: z.number().int().describe('Done runs the mean is taken over'),
      meanCostUsd: z.number().nullable(),
      totalUsd: z.number().nullable().describe('Mean cost × cases; null without priced history'),
    }),
  }),
  fingerprints: z
    .array(z.string())
    .describe('The fingerprints the replayed runs ran on (one, unless a deploy crossed)'),
  cases: z.array(CaseResult),
  summary: z.object({
    scored: z.number().int(),
    skipped: z.number().int(),
    errors: z.number().int(),
    passRate: z.number().nullable(),
    means: z.record(z.string(), z.number()).describe('Each score averaged over the scored cases that have it'),
  }),
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function select(cases: EvalCase[], ids: string | undefined, limit: number | undefined): EvalCase[] {
  let selected = cases
  if (ids) {
    const wanted = ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    const byId = new Map(cases.map((c) => [c.id, c]))
    const unknown = wanted.filter((id) => !byId.has(id))
    if (unknown.length) throw new WorkflowError('invalid_input', `unknown case ids: ${unknown.join(', ')}`)
    selected = wanted.map((id) => byId.get(id) as EvalCase)
  }
  return limit === undefined ? selected : selected.slice(0, limit)
}

function summarize(cases: CaseResult[]) {
  const scored = cases.filter((c) => c.status === 'scored')
  const sums = new Map<string, { sum: number; n: number }>()
  for (const c of scored) {
    for (const [name, value] of Object.entries(c.scores ?? {})) {
      const cell = sums.get(name) ?? { sum: 0, n: 0 }
      sums.set(name, { sum: cell.sum + value, n: cell.n + 1 })
    }
  }
  return {
    scored: scored.length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    errors: cases.filter((c) => c.status === 'error').length,
    passRate: scored.length ? scored.filter((c) => c.pass).length / scored.length : null,
    means: Object.fromEntries([...sums].map(([name, c]) => [name, c.sum / c.n])),
  }
}

/**
 * `agw eval run <workflow>` (concept §6, regression): replays the recorded cases on the current fingerprint. Each case
 * is materialized (the harness's `materialize`), run as its own top-level run with purpose `eval` (keyed by this run
 * and the case, so a resume adopts the runs already started instead of paying twice), scored against the case's
 * reference and recorded on that run (`scores.final`, `source: regression`). Without `--yes` it answers the plan and an
 * estimate and spends nothing.
 */
export function createEvalRun(slot: EvalSlot, options: EvalRunOptions = {}): HostWorkflow {
  const env = options.env ?? process.env
  const exec = options.exec ?? bunExec
  const home = env.AGW_EVAL_HOME?.trim() || homedir()

  const workflow = defineWorkflow({
    id: EVAL_RUN_ID,
    version: '2026-10-28.1',
    input: EvalRunInput,
    output: EvalRunOutput,
    async run(ctx, input) {
      const args = input.args ?? {}
      const plan = await ctx.step('plan', async () => {
        const target = slot.target(input.workflow)
        let cases: EvalCase[]
        try {
          cases = readSuite(input.workflow, env)
        } catch (error) {
          throw new WorkflowError('invalid_input', `${input.workflow} cases: ${errorText(error)}`)
        }
        const selected = select(cases, input.ids, input.limit)
        const first = selected[0]
        const probe = first ? target.input.safeParse(first.input('/agw-eval-plan', args)) : null
        if (probe && !probe.success) {
          throw new WorkflowError(
            'invalid_input',
            `args do not fit the ${input.workflow} input: ${z.prettifyError(probe.error)}`,
          )
        }
        const history = await slot.get().recentCost(input.workflow, ESTIMATE_HISTORY)
        return {
          ids: selected.map((c) => c.id),
          estimate: {
            historyRuns: history.runs,
            meanCostUsd: history.meanCost,
            totalUsd: history.meanCost === null ? null : history.meanCost * selected.length,
          },
        }
      })
      const planned = { workflow: input.workflow, args, plan, fingerprints: [] }
      if (!input.yes) return { ...planned, ran: false, cases: [], summary: summarize([]) }

      const results = await ctx.step('cases', ({ signal }) =>
        replay(
          { slot, exec, env, home, tmpRoot: options.tmpRoot },
          {
            evalRunId: ctx.runId,
            workflow: input.workflow,
            ids: plan.ids,
            args,
            concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
            signal,
          },
        ),
      )
      const fingerprints = [...new Set(results.flatMap((c) => (c.fingerprint ? [c.fingerprint] : [])))]
      return { ...planned, ran: true, fingerprints, cases: results, summary: summarize(results) }
    },
  })
  return {
    workflow,
    summary: 'Replay a workflow’s recorded eval cases on the current fingerprint and score them (--yes spends)',
    cli: { positional: ['workflow'], defaultFormat: 'json' },
  }
}

type ReplayDeps = {
  slot: EvalSlot
  exec: Exec
  env: Record<string, string | undefined>
  home: string
  tmpRoot: string | undefined
}

async function replay(
  deps: ReplayDeps,
  job: {
    evalRunId: string
    workflow: SuiteId
    ids: string[]
    args: Record<string, Json>
    concurrency: number
    signal: AbortSignal
  },
): Promise<CaseResult[]> {
  const runtime = deps.slot.get()
  const target = deps.slot.target(job.workflow)
  const byId = new Map(readSuite(job.workflow, deps.env).map((c) => [c.id, c]))
  const results: CaseResult[] = []
  const started = new Set<string>()
  // A cancelled eval run cancels its cases; a shutdown leaves them running for the next process to adopt.
  const onAbort = () => {
    if (!(job.signal.reason instanceof Cancelled)) return
    for (const runId of started) runtime.cancel(runId).catch(() => {})
  }
  job.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await pool(job.ids, job.concurrency, async (caseId, index) => {
      job.signal.throwIfAborted()
      const c = byId.get(caseId)
      if (!c) {
        results[index] = { caseId, status: 'error', reason: 'the case left the case set since the plan' }
        return
      }
      results[index] = await replayCase(deps, job, c, started)
    })
  } finally {
    job.signal.removeEventListener('abort', onAbort)
  }
  const scored = await runtime.scoredRuns({ workflow: target.id, source: 'regression' })
  const fingerprints = new Map(scored.map((r) => [r.runId, r.fingerprint]))
  return results.map((r) =>
    r.runId && fingerprints.has(r.runId) ? { ...r, fingerprint: fingerprints.get(r.runId) } : r,
  )
}

async function replayCase(
  deps: ReplayDeps,
  job: { evalRunId: string; workflow: SuiteId; args: Record<string, Json>; signal: AbortSignal },
  c: EvalCase,
  started: Set<string>,
): Promise<CaseResult> {
  const runtime = deps.slot.get()
  const tree = await materialize(c.tree, { exec: deps.exec, home: deps.home, tmpRoot: deps.tmpRoot, setup: c.setup })
  try {
    if (!tree.ok) return { caseId: c.id, status: 'skipped', reason: `${tree.reason}: ${tree.detail}` }
    let runId: string
    try {
      ;({ runId } = await runtime.start(deps.slot.target(job.workflow), c.input(tree.dir, job.args), {
        purpose: 'eval',
        idempotencyKey: `eval:${job.evalRunId}:${c.id}`,
      }))
    } catch (error) {
      // A resumed eval run: the case started before (on a clone that is gone now); that run stands.
      if (!(error instanceof IdempotencyConflict)) throw error
      runId = error.runId
    }
    started.add(runId)
    const end = await runtime.wait(runId, { pollMs: 500, signal: job.signal })
    const final = await runtime.scoreRun(runId, {
      source: 'regression',
      reference: c.reference,
      caseId: c.id,
      evalRunId: job.evalRunId,
      args: job.args,
    })
    if (!final) return { caseId: c.id, status: 'error', runId, runStatus: end.status, reason: `run ${end.status}` }
    return {
      caseId: c.id,
      status: 'scored',
      runId,
      runStatus: end.status,
      pass: final.pass,
      scores: final.scores,
      ...(final.error ? { reason: `scorer: ${final.error}` } : end.error ? { reason: end.error.message } : {}),
    }
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason
    return { caseId: c.id, status: 'error', reason: errorText(error) }
  } finally {
    // After an abort the case's run may go on in the next process: its tree stays.
    if (tree.dir && !job.signal.aborted) cleanup(tree.dir)
  }
}
