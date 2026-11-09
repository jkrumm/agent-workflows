import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as bunExec, type Exec, materialize } from '@agent-workflows/eval'
import { RouteOverrideError, validateArm } from '@agent-workflows/routes'
import {
  type AnyWorkflow,
  Cancelled,
  defineWorkflow,
  type FinalScore,
  IdempotencyConflict,
  type Json,
  type Logger,
  type RunSnapshot,
  WorkflowError,
} from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { EvalRuntime, EvalSlot } from './slot.ts'
import { type EvalCase, readSuite, type Suites, suiteIds } from './suites.ts'

export const EVAL_RUN_ID = 'eval.run'
/** Estimates read the latest this many done runs of the workflow. */
const ESTIMATE_HISTORY = 50
export const DEFAULT_CONCURRENCY = 2
/** How often a case run is polled: for its end, then for its record. */
const CASE_POLL_MS = 500
/** How long an ended case run's record may take before its last-read cost is reported as a lower bound. */
export const RECORD_SETTLE_MS = 120_000
/** How long a case run of a workflow another process serves may stay pending before nobody is taken to be serving it. */
export const NOT_CLAIMED_MS = 10 * 60_000

export interface EvalRunOptions {
  env?: Record<string, string | undefined>
  exec?: Exec
  /** Where materialized clones go. Default: the OS temp dir. */
  tmpRoot?: string
  /** Warnings about a case cost that is only a lower bound. Default: the console. */
  logger?: Logger
  /** Overrides {@link RECORD_SETTLE_MS} (tests). */
  recordSettleMs?: number
  /** Overrides {@link NOT_CLAIMED_MS} (tests). */
  notClaimedMs?: number
  /** Overrides the case-run poll interval (tests). */
  casePollMs?: number
}

export const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-eval] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-eval] ${message}`, meta ?? ''),
}

/** Plain JSON from the wire; the runtime refuses anything else on the run input. */
export const JsonRecord = z.record(z.string(), z.unknown()) as unknown as z.ZodType<Record<string, Json>>

/**
 * An arm: route patches over the table and workflow params, for this eval run and every run below it (its case runs,
 * their children, its judge calls); production never sees it. Validated whole at admission (`validateArm`: an unknown
 * route, a bad patch, a Sonnet at effort none, an agent model the OpenCode server does not serve are each refused,
 * naming the route). The CLI reads `--arm <file>` and sends the file's JSON, never the path.
 */
export const ArmInput = z
  .strictObject({
    routes: z
      .record(z.string(), JsonRecord)
      .optional()
      .describe('Route id → patch over its table entry: model, effort, maxOutputTokens, rate, price, fallback'),
    params: JsonRecord.optional().describe('Workflow knobs by name, read with a default (`ctx.param`)'),
  })
  .superRefine((arm, ctx) => {
    try {
      validateArm(arm)
    } catch (error) {
      if (!(error instanceof RouteOverrideError)) throw error
      ctx.addIssue({ code: 'custom', message: error.message })
    }
  })
  .describe(
    'An arm file (JSON): route patches and params for this eval run and every run below it; kept in its input and fingerprint',
  )

/** The `agw eval run` input over the discovered suites' ids. */
export const evalRunInput = (ids: [string, ...string[]]) =>
  z
    .object({
      workflow: z.enum(ids).describe('The workflow to replay its recorded cases against'),
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
      arm: ArmInput.optional(),
      yes: z
        .boolean()
        .optional()
        .describe('Run the cases: spends IU money. Without it, only the plan and a cost estimate; nothing runs'),
    })
    .strict()

export const CaseResult = z.object({
  caseId: z.string(),
  status: z.enum(['scored', 'skipped', 'error']),
  runId: z.string().optional(),
  runStatus: z.string().optional(),
  fingerprint: z.string().nullable().optional(),
  pass: z.boolean().optional(),
  scores: z.record(z.string(), z.number()).optional(),
  costUsd: z
    .number()
    .nullable()
    .optional()
    .describe(
      "The case run's recorded cost (with its child runs'): 0 when every step was free, null when unknown (a call nobody priced)",
    ),
  unpricedCalls: z.number().int().optional().describe('Calls the cost misses: a lower bound while above 0'),
  reason: z.string().optional(),
})
export type CaseResult = z.infer<typeof CaseResult>

export const RunSummary = z.object({
  scored: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  passRate: z.number().nullable(),
  means: z.record(z.string(), z.number()).describe('Each score averaged over the scored cases that have it'),
  costUsd: z
    .number()
    .nullable()
    .describe(
      "The case runs' recorded costs summed (0: every step free); null when no case cost is known. This run's own `cost` adds the judge calls",
    ),
  unpricedCalls: z.number().int().describe('Calls no case cost includes: the total is a lower bound while above 0'),
})

export const evalRunOutput = (ids: [string, ...string[]]) =>
  z.object({
    workflow: z.enum(ids),
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
    summary: RunSummary,
  })

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function select(cases: EvalCase[], ids: string | undefined, limit: number | undefined): EvalCase[] {
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

export function summarize(cases: CaseResult[]) {
  const scored = cases.filter((c) => c.status === 'scored')
  const priced = cases.flatMap((c) => (typeof c.costUsd === 'number' ? [c.costUsd] : []))
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
    costUsd: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
    unpricedCalls: cases.reduce((n, c) => n + (c.unpricedCalls ?? 0), 0),
  }
}

/**
 * `agw eval run <workflow>` (concept §6, regression): replays the recorded cases on the current fingerprint. Each case
 * is materialized (the harness's `materialize`), run as a child of this run (`parent_id`, its own root: leased and
 * redelivered on its own, by the process that serves the workflow) with purpose `eval` (keyed by this run and the case,
 * so a resume adopts the runs already started instead of paying twice), scored against the case's reference and
 * recorded on that run (`scores.final`, `source: regression`). Each case's cost is read once its run record is
 * written, so this run's `cost` (its children's summed by the record) is the eval's spend. Without `--yes` it answers
 * the plan and an estimate and spends nothing.
 */
export function createEvalRun(slot: EvalSlot, suites: Suites, options: EvalRunOptions = {}): HostWorkflow {
  const ids = suiteIds(suites)
  slot.tmpRoot = options.tmpRoot
  const env = options.env ?? process.env
  const exec = options.exec ?? bunExec
  const home = env.AGW_EVAL_HOME?.trim() || homedir()

  const workflow = defineWorkflow({
    id: EVAL_RUN_ID,
    version: '2026-11-02.2',
    input: evalRunInput(ids),
    output: evalRunOutput(ids),
    // The arm goes on this run's row; every case run (a child), its children and the judge's calls inherit it.
    arm: (input) => input.arm,
    async run(ctx, input) {
      const args = input.args ?? {}
      const plan = await ctx.step('plan', async () => {
        const target = slot.target(input.workflow)
        let cases: EvalCase[]
        try {
          cases = readSuite(suites, input.workflow, env)
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

      const results = await ctx.step('cases', async ({ signal }) =>
        replay(
          {
            slot,
            exec,
            home,
            tmpRoot: options.tmpRoot,
            logger: options.logger ?? consoleLogger,
            recordSettleMs: options.recordSettleMs ?? RECORD_SETTLE_MS,
            notClaimedMs: options.notClaimedMs ?? NOT_CLAIMED_MS,
            casePollMs: options.casePollMs ?? CASE_POLL_MS,
          },
          {
            evalRunId: ctx.runId,
            target: slot.target(input.workflow),
            cases: readSuite(suites, input.workflow, env),
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
  home: string
  tmpRoot: string | undefined
  logger: Logger
  recordSettleMs: number
  notClaimedMs: number
  casePollMs: number
}

type Job = {
  evalRunId: string
  /** The workflow each case runs and is scored by. */
  target: AnyWorkflow
  /** The replayable cases; `ids` selects and orders among them. */
  cases: EvalCase[]
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

export async function replay(deps: ReplayDeps, job: Job): Promise<CaseResult[]> {
  const runtime = deps.slot.get()
  const { target } = job
  const byId = new Map(job.cases.map((c) => [c.id, c]))
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

type Spent = Pick<RunSnapshot, 'cost' | 'unpricedCalls'>

/** A case's result from its run and its regression score; a scorer error is an error result, never a verdict. */
function scoredResult(
  caseId: string,
  runId: string,
  end: { status: string; error: { message: string } | null },
  final: FinalScore | null,
  spent: Spent,
): CaseResult {
  const base = { caseId, runId, runStatus: end.status, costUsd: spent.cost, unpricedCalls: spent.unpricedCalls }
  if (!final) return { ...base, status: 'error', reason: `run ${end.status}` }
  if (final.error !== undefined || final.pass === null) {
    return { ...base, status: 'error', reason: `scorer: ${final.error ?? 'no verdict'}` }
  }
  return {
    ...base,
    status: 'scored',
    pass: final.pass,
    scores: final.scores,
    ...(end.error ? { reason: end.error.message } : {}),
  }
}

/**
 * The ended case run's cost from its record, once its `runPost` was delivered. A record given up on
 * (`postHooksFailed`), or one still missing `recordSettleMs` after the run ended, is reported as last read and counted
 * unpriced (at least one call), so the case cost reads as a lower bound; either is logged. (The eval run's own `cost`
 * sums its descendants' step rows, so it never depends on this read.)
 */
async function recorded(deps: ReplayDeps, runId: string, signal: AbortSignal): Promise<Spent> {
  const runtime = deps.slot.get()
  const deadline = Date.now() + deps.recordSettleMs
  for (;;) {
    const run = await runtime.getRun(runId)
    if (!run) throw new Error(`case run ${runId} vanished`)
    if (run.postHooksDone && !run.postHooksFailed) return { cost: run.cost, unpricedCalls: run.unpricedCalls }
    if (run.postHooksFailed || Date.now() >= deadline) {
      const why = run.postHooksFailed
        ? 'its record was given up on'
        : `its record was not written within ${deps.recordSettleMs / 1000} s`
      deps.logger.warn(`eval case run ${runId}: ${why}; its cost is reported as a lower bound`, { cost: run.cost })
      return { cost: run.cost, unpricedCalls: Math.max(1, run.unpricedCalls) }
    }
    signal.throwIfAborted()
    await Bun.sleep(deps.casePollMs)
  }
}

/**
 * An adopted or a freshly started case run to its result, one path for both: wait for its end (an adopted run whose
 * verdict stands has ended), read its cost, then score it (unless the verdict stands). A failure after the cost was
 * read, such as the scoring, keeps the cost on the error result.
 */
async function settleCase(
  deps: ReplayDeps,
  job: Job,
  caseId: string,
  runId: string,
  score: () => Promise<FinalScore | null>,
  standing: { end: { status: string; error: { message: string } | null }; final: FinalScore } | null,
): Promise<CaseResult> {
  const runtime = deps.slot.get()
  const foreign = deps.slot.foreign.has(job.target.id)
  const waited = standing ? standing.end : await awaitEnd(deps, job, runId, foreign)
  if (waited === 'not-claimed') {
    return { caseId, runId, status: 'error', reason: 'not claimed: is the audio process up?' }
  }
  const end = waited
  const spent = await recorded(deps, runId, job.signal)
  try {
    // The run was driven by another process, possibly of another release: its scorer is the version this host holds.
    const version = !standing && foreign ? ((await runtime.getRun(runId))?.version ?? null) : job.target.version
    if (version !== job.target.version) {
      const base = { caseId, runId, runStatus: end.status, costUsd: spent.cost, unpricedCalls: spent.unpricedCalls }
      return {
        ...base,
        status: 'error',
        reason: `version skew: run ${version ?? 'unknown'} vs scorer ${job.target.version}`,
      }
    }
    return scoredResult(caseId, runId, end, standing ? standing.final : await score(), spent)
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason
    const base = { caseId, runId, runStatus: end.status, costUsd: spent.cost, unpricedCalls: spent.unpricedCalls }
    return { ...base, status: 'error', reason: errorText(error) }
  }
}

/**
 * The end of a case run. A run of a workflow another process serves is first awaited as pending: left pending for
 * `notClaimedMs` it is cancelled (it must not run, and spend, after the eval gave up on it) and the case is `not-claimed`.
 * A run that was claimed, and every run of a workflow served here, is awaited as ever.
 */
async function awaitEnd(deps: ReplayDeps, job: Job, runId: string, foreign: boolean) {
  const runtime = deps.slot.get()
  if (foreign) {
    const since = Date.now()
    for (;;) {
      const run = await runtime.getRun(runId)
      if (!run) throw new Error(`case run ${runId} vanished`)
      if (run.status !== 'pending') break
      if (Date.now() - since >= deps.notClaimedMs) {
        await runtime.cancel(runId).catch(() => {})
        return 'not-claimed' as const
      }
      job.signal.throwIfAborted()
      await Bun.sleep(deps.casePollMs)
    }
  }
  return runtime.wait(runId, { pollMs: deps.casePollMs, signal: job.signal })
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
  const { target } = job
  const key = caseKey(job.evalRunId, c.id)
  const dir = caseTreeDir(deps.tmpRoot, key)
  const score = (runId: string) => () =>
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
      const { final } = existing
      const stands = final?.source === 'regression' && final.evalRunId === job.evalRunId && final.error === undefined
      return await settleCase(deps, job, c.id, runId, score(runId), stands ? { end: existing, final } : null)
    }

    neverStarted = true
    job.signal.throwIfAborted()
    rmSync(dir, { recursive: true, force: true }) // a tree left by a drive that died before its run started
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CASE_MARKER), JSON.stringify({ workflow: target.id, key }))
    const tree = c.tree
      ? await materialize(c.tree, { exec: deps.exec, home: deps.home, tmpRoot: dir, setup: c.setup })
      : ({ ok: true, dir } as const)
    if (!tree.ok) return { caseId: c.id, status: 'skipped', reason: `${tree.reason}: ${tree.detail}` }
    // A cancel during the clone: start nothing.
    job.signal.throwIfAborted()
    neverStarted = false // from here a run may exist even if start throws
    try {
      ;({ runId } = await runtime.start(target, c.input(tree.dir, job.args), {
        purpose: 'eval',
        idempotencyKey: key,
        parentId: job.evalRunId,
      }))
    } catch (error) {
      // Another drive of this eval run started the case in between; that run stands.
      if (!(error instanceof IdempotencyConflict)) throw error
      runId = error.runId
    }
    started.add(runId)
    // Started after the abort fired (the abort handler never saw it): `releaseTree` cancels it.
    job.signal.throwIfAborted()
    return await settleCase(deps, job, c.id, runId, score(runId), null)
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason
    return { caseId: c.id, status: 'error', ...(runId ? { runId } : {}), reason: errorText(error) }
  } finally {
    await releaseTree(runtime, job.signal, dir, { runId, neverStarted })
  }
}
