import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as bunExec, type Exec, materialize } from '@agent-workflows/eval'
import {
  Cancelled,
  defineWorkflow,
  type FinalScore,
  IdempotencyConflict,
  type Json,
  WorkflowError,
} from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { EvalRuntime, EvalSlot } from './slot.ts'
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
      'Extra workflow input for every case, the experiment arm, e.g. {"depth":"deep"}; kept with each score for `agw eval compare --a-args/--b-args`',
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
    const wanted = [
      ...new Set(
        ids
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ]
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
  slot.tmpRoot = options.tmpRoot
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

type Job = {
  evalRunId: string
  workflow: SuiteId
  ids: string[]
  args: Record<string, Json>
  concurrency: number
  signal: AbortSignal
}

/**
 * `items` through `fn`, at most `limit` at a time. Unlike the harness's `pool`, the first rejection stops every worker
 * from taking another item (siblings in flight finish), and the rejection is rethrown once all have settled.
 */
async function boundedPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (failure === null && next < items.length) {
      const index = next++
      try {
        await fn(items[index] as T, index)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failure) throw (failure as { error: unknown }).error
}

const caseKey = (evalRunId: string, caseId: string) => `eval:${evalRunId}:${caseId}`

async function replay(deps: ReplayDeps, job: Job): Promise<CaseResult[]> {
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
    await boundedPool(job.ids, job.concurrency, async (caseId, index) => {
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
  // Only this eval run's case runs, by id.
  const runIds = results.flatMap((r) => (r.runId ? [r.runId] : []))
  const scored = runIds.length ? await runtime.scoredRuns({ workflow: target.id, source: 'regression', runIds }) : []
  const fingerprints = new Map(scored.map((r) => [r.runId, r.fingerprint]))
  return results.map((r) =>
    r.runId && fingerprints.has(r.runId) ? { ...r, fingerprint: fingerprints.get(r.runId) } : r,
  )
}

/** A case's result from its run and its regression score; a scorer error is an error result, never a verdict. */
function scoredResult(
  caseId: string,
  runId: string,
  end: { status: string; error: { message: string } | null },
  final: FinalScore | null,
): CaseResult {
  if (!final) return { caseId, status: 'error', runId, runStatus: end.status, reason: `run ${end.status}` }
  if (final.error !== undefined || final.pass === null) {
    return { caseId, status: 'error', runId, runStatus: end.status, reason: `scorer: ${final.error ?? 'no verdict'}` }
  }
  return {
    caseId,
    status: 'scored',
    runId,
    runStatus: end.status,
    pass: final.pass,
    scores: final.scores,
    ...(end.error ? { reason: end.error.message } : {}),
  }
}

/** How long a cancelled case run gets to reach a terminal state before its tree is removed (a helper bound). */
const CANCEL_SETTLE_MS = 30_000

/**
 * Where a case's clone lives: derived from the case key, so the process that adopts the case run after a shutdown
 * finds the tree the first one kept and removes it. Hex only: a repo-shell deny rule can never match it.
 */
export function caseTreeDir(tmpRoot: string | undefined, key: string): string {
  return join(tmpRoot ?? tmpdir(), `agw_eval_case_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`)
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** Written into a case's tree directory first, so the sweep can find the run that tree belongs to. */
const CASE_MARKER = '.agw-case.json'

/**
 * A case's tree is removed only when its run is known ended (a terminal status, read now) or known never started (the
 * lookup said there is none and no start was tried). Anything unknown (a failed read, a live run, a start that threw)
 * keeps it; the sweep removes it later. A shutdown or a lost lease keeps it for the next process, which adopts the run
 * and removes it; a cancel first cancels the run and waits (bounded) for it to end.
 */
async function releaseTree(
  runtime: EvalRuntime,
  signal: AbortSignal,
  dir: string,
  run: { runId: string | null; neverStarted: boolean },
) {
  if (signal.aborted && !(signal.reason instanceof Cancelled)) return
  if (run.runId) {
    if (signal.aborted) {
      await runtime.cancel(run.runId).catch(() => {})
      await runtime
        .wait(run.runId, { pollMs: 100, signal: AbortSignal.timeout(CANCEL_SETTLE_MS) })
        .catch(() => undefined)
    }
    const state = await runtime.getRun(run.runId).catch(() => null)
    if (!state || !TERMINAL.has(state.status)) return
  } else if (!run.neverStarted) {
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Removes case tree directories older than `olderThanMs` whose marker names a run that ended or does not exist, so a
 * cancel past its 30 s settle or a killed process leaks nothing for long. A live run, a failed lookup, or a directory
 * without a marker (its run is unknown) keeps its tree; the last is reported through `onUnmarked`. Returns the
 * removed directories.
 */
export async function sweepCaseTrees(options: {
  runtime: Pick<EvalRuntime, 'runByKey'>
  tmpRoot: string | undefined
  olderThanMs: number
  now?: number
  /** Called for an old case directory without a marker: never deleted (its run is unknown), only reported. */
  onUnmarked?: (dir: string) => void
}): Promise<string[]> {
  const root = options.tmpRoot ?? tmpdir()
  const now = options.now ?? Date.now()
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(root).filter((name) => name.startsWith('agw_eval_case_'))
  } catch {
    return removed
  }
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (now - statSync(dir).mtimeMs < options.olderThanMs) continue
      const marker = join(dir, CASE_MARKER)
      if (!existsSync(marker)) {
        options.onUnmarked?.(dir)
        continue
      }
      const { workflow, key } = JSON.parse(readFileSync(marker, 'utf8')) as { workflow: string; key: string }
      const run = await options.runtime.runByKey(workflow, key)
      if (run && !TERMINAL.has(run.status)) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      // A failed lookup or read keeps the tree: the next sweep tries again.
    }
  }
  return removed
}

async function replayCase(deps: ReplayDeps, job: Job, c: EvalCase, started: Set<string>): Promise<CaseResult> {
  const runtime = deps.slot.get()
  const target = deps.slot.target(job.workflow)
  const key = caseKey(job.evalRunId, c.id)
  const dir = caseTreeDir(deps.tmpRoot, key)
  const score = (runId: string) =>
    runtime.scoreRun(runId, {
      source: 'regression',
      reference: c.reference,
      caseId: c.id,
      evalRunId: job.evalRunId,
      args: job.args,
    })
  let runId: string | null = null
  /** The lookup found no run and no start was tried yet: a tree here belongs to nobody. */
  let neverStarted = false
  try {
    // A resumed eval run: the case started before. Adopt its run: no clone, no install, and no second score.
    const existing = await runtime.runByKey(target.id, key)
    if (existing) {
      runId = existing.runId
      started.add(runId)
      // A recorded verdict stands; a recorded scorer error is scored again.
      if (
        existing.final?.source === 'regression' &&
        existing.final.evalRunId === job.evalRunId &&
        existing.final.error === undefined
      ) {
        return scoredResult(c.id, runId, existing, existing.final)
      }
      const end = await runtime.wait(runId, { pollMs: 500, signal: job.signal })
      return scoredResult(c.id, runId, end, await score(runId))
    }

    neverStarted = true
    job.signal.throwIfAborted()
    rmSync(dir, { recursive: true, force: true }) // a tree left by a drive that died before its run started
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CASE_MARKER), JSON.stringify({ workflow: target.id, key }))
    const tree = await materialize(c.tree, { exec: deps.exec, home: deps.home, tmpRoot: dir, setup: c.setup })
    if (!tree.ok) return { caseId: c.id, status: 'skipped', reason: `${tree.reason}: ${tree.detail}` }
    // A cancel during the clone: start nothing.
    job.signal.throwIfAborted()
    neverStarted = false // from here a run may exist even if start throws
    try {
      ;({ runId } = await runtime.start(target, c.input(tree.dir, job.args), { purpose: 'eval', idempotencyKey: key }))
    } catch (error) {
      // Another drive of this eval run started the case in between; that run stands.
      if (!(error instanceof IdempotencyConflict)) throw error
      runId = error.runId
    }
    started.add(runId)
    // Started after the abort fired (the abort handler never saw it): `releaseTree` cancels it.
    job.signal.throwIfAborted()
    const end = await runtime.wait(runId, { pollMs: 500, signal: job.signal })
    return scoredResult(c.id, runId, end, await score(runId))
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason
    return { caseId: c.id, status: 'error', ...(runId ? { runId } : {}), reason: errorText(error) }
  } finally {
    await releaseTree(runtime, job.signal, dir, { runId, neverStarted })
  }
}
