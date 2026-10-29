import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { type CheckCase, evalDir, type ReviewCase } from '../cases.ts'
import { matchFindings } from './match.ts'
import type { ReproducibleCases } from './aggregate.ts'
import type { CheckRunner, Judge, Located, ReviewRunner } from './ports.ts'
import { type HarnessOptions, pool, requestedDepth, withTree } from './run.ts'
import { rate } from './stats.ts'

/**
 * Reproducibility of an eval set (PLAN Wave 5): before recorded findings count as a baseline, the new side reruns each
 * case N times and the runs are compared with each other and with the recorded reference. Wave 4 found that
 * agent-gateway's own rerun recovered none of its recorded blockers, so a recorded finding is no ground truth until
 * the case shows it comes back.
 *
 * A case is **reproducible** when, over every pair of runs (the recorded one and the N reruns, the earlier run as
 * the reference), the outcomes agree in at least `threshold` of the pairs and, if any reference run had blocking
 * findings, at least `threshold` of those were found again. The default is 0.5: with the recorded run and two
 * reruns (three pairs) that means all three outcomes agree, since two agreeing pairs imply the third.
 *
 * The rows hold the raw agreement numbers; the threshold is applied when they are read (`isReproducible`,
 * `reproducibleCases`), so a different `--threshold` takes effect without measuring again.
 *
 * The comparisons are every pair of the recorded run and the reruns, (runs + 1) choose 2: with the judge on, each
 * pair can add judge calls for its unsure findings, so keep `--runs` small (the default 2 is three pairs).
 */
export const DEFAULT_THRESHOLD = 0.5

export type Side = 'legacy' | 'new'

export const ReproducibilityRow = z.object({
  id: z.string(),
  side: z.enum(['legacy', 'new']),
  /** The reruns behind the numbers; the recorded run is compared on top. */
  runs: z.number().int().min(2),
  /** Pairs of runs with the same outcome (review `outcome`, check `passed`) / all pairs. */
  outcomeAgreement: z.number().min(0).max(1),
  /** Blocking findings (check: red runs) of the earlier run of a pair found again in the later one, pooled; `null`: no run had any. */
  blockingRecall: z.number().min(0).max(1).nullable(),
})
export type ReproducibilityRow = z.infer<typeof ReproducibilityRow>

export function reproducibilityPath(workflow: 'review' | 'check', env: Record<string, string | undefined>) {
  return join(evalDir(env), workflow, 'reproducibility.jsonl')
}

/** Appends one row (mode 0600, like every eval file). */
export function appendRow(path: string, row: ReproducibilityRow): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
}

/** The rows so far; a torn or invalid line is ignored, and a later row for the same case and side wins. */
export function readRows(path: string): ReproducibilityRow[] {
  if (!existsSync(path)) return []
  const rows = new Map<string, ReproducibilityRow>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = ReproducibilityRow.parse(JSON.parse(line))
      rows.set(`${row.side}:${row.id}`, row)
    } catch {}
  }
  return [...rows.values()]
}

/** The threshold applied to a row's raw numbers: both must reach it; a recall of `null` (no run had a blocker) is not held against the case. */
export const isReproducible = (row: ReproducibilityRow, threshold: number) =>
  row.outcomeAgreement >= threshold && (row.blockingRecall === null || row.blockingRecall >= threshold)

/**
 * Which cases the recorded findings can be scored on at `threshold`, from the legacy rows: the recorded reference is a
 * legacy artifact, so legacy's reruns are the ones that say whether it comes back. `null`: no legacy rows at all, so
 * nothing is known (the report says so). Rows of the `new` side never feed scoring.
 */
export function reproducibleCases(rows: ReproducibilityRow[], threshold: number): ReproducibleCases | null {
  const legacy = rows.filter((r) => r.side === 'legacy')
  if (!legacy.length) return null
  return { threshold, byId: new Map(legacy.map((r) => [r.id, isReproducible(r, threshold)])) }
}

/** One run as the comparison sees it: its outcome, and what a later run is asked to find again. */
interface View {
  outcome: string
  /** Review: the blocking findings. */
  blocking: Located[]
  /** Check: the run was red. */
  red: boolean
}

type Recall = (reference: View, other: View) => Promise<{ reference: number; matched: number }>

async function measure(views: View[], recall: Recall) {
  let pairs = 0
  let agreed = 0
  let reference = 0
  let matched = 0
  for (const [i, a] of views.entries()) {
    for (const b of views.slice(i + 1)) {
      pairs++
      if (a.outcome === b.outcome) agreed++
      const found = await recall(a, b)
      reference += found.reference
      matched += found.matched
    }
  }
  return { outcomeAgreement: agreed / pairs, blockingRecall: rate(matched, reference) }
}

/** `resultsPath` is the workflow's `reproducibility.jsonl`. */
export interface SelfAgreementOptions extends HarnessOptions {
  /** Reruns per case, at least 2. */
  runs: number
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Skips the cases already measured with at least this many reruns: the file is the resume point. */
function pending<C extends { id: string }>(cases: C[], options: SelfAgreementOptions): C[] {
  const done = new Set(
    readRows(options.resultsPath)
      .filter((r) => r.side === 'new' && r.runs >= options.runs)
      .map((r) => r.id),
  )
  const todo = cases.filter((c) => !done.has(c.id))
  if (todo.length < cases.length) {
    options.log?.(`resume: ${cases.length - todo.length} cases already measured (delete the file to measure again)`)
  }
  return todo
}

/** What one case came to; a case any rerun failed on, or that never materialized, gets no row. */
export interface CaseOutcome {
  id: string
  status: 'measured' | 'skipped' | 'error'
  detail?: string
}

interface Plan<C extends { id: string }, V> {
  tree: (c: C) => { repo: string; baseSha: string; patch?: string; setup: boolean }
  rerun: (c: C, dir: string) => Promise<V>
  view: (run: V) => View
  recorded: (c: C) => View
  recall: (c: C) => Recall
}

async function rerunAll<C extends { id: string }, V>(
  cases: C[],
  options: SelfAgreementOptions,
  plan: Plan<C, V>,
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = []
  await pool(pending(cases, options), options.concurrency, async (c) => {
    const { setup, ...tree } = plan.tree(c)
    const outcome = await withTree<CaseOutcome>(
      options,
      tree,
      setup,
      async ({ dir }) => {
        const views = [plan.recorded(c)]
        for (let run = 0; run < options.runs; run++) views.push(plan.view(await plan.rerun(c, dir)))
        const m = await measure(views, plan.recall(c))
        appendRow(options.resultsPath, { id: c.id, side: 'new', runs: options.runs, ...m })
        return { id: c.id, status: 'measured' }
      },
      (skipped) => ({ id: c.id, status: 'skipped', detail: skipped.reason }),
    ).catch((error: unknown): CaseOutcome => ({ id: c.id, status: 'error', detail: errorText(error) }))
    options.log?.(`${outcome.status.padEnd(8)} ${c.id}${outcome.detail ? ` (${outcome.detail})` : ''}`)
    outcomes.push(outcome)
  })
  return outcomes
}

const recordedBlocking = (c: ReviewCase): Located[] =>
  c.legacy.findings
    .filter((f) => f.severity === 'blocking')
    .map((f) => ({ file: f.file, line: f.line ?? null, message: f.message }))

export interface ReviewReruns {
  /** The side under test. */
  runner: ReviewRunner
  judge?: Judge
}

export function selfAgreementReview(cases: ReviewCase[], ports: ReviewReruns, options: SelfAgreementOptions) {
  return rerunAll(cases, options, {
    tree: (c) => ({ repo: c.repo, baseSha: c.baseSha, patch: c.diff, setup: false }),
    rerun: (c, dir) => {
      const depth = requestedDepth(c, options.depthMode)
      const request = {
        cwd: dir,
        ...(depth ? { depth } : {}),
        ...(c.input.context ? { context: c.input.context } : {}),
      }
      return ports.runner.review(request)
    },
    view: (run) => ({
      outcome: run.output.outcome,
      blocking: run.output.blocking.map((f) => ({ file: f.file, line: f.line ?? null, message: f.message })),
      red: false,
    }),
    recorded: (c) => ({ outcome: c.legacy.outcome, blocking: recordedBlocking(c), red: false }),
    recall: (c) => async (reference, other) => {
      const found = await matchFindings(reference.blocking, other.blocking, { judge: ports.judge, diff: c.diff })
      return { reference: found.reference, matched: found.matched }
    },
  })
}

/** Check has no findings to match: a red run is the one thing a later run must show again (the failure recall). */
export function selfAgreementCheck(cases: CheckCase[], runner: CheckRunner, options: SelfAgreementOptions) {
  return rerunAll(cases, options, {
    tree: (c) => ({ repo: c.repo, baseSha: c.baseSha, patch: c.patch, setup: true }),
    rerun: (c, dir) => runner.check({ cwd: dir, ...(c.input.commands ? { commands: c.input.commands } : {}) }),
    view: (run) => ({ outcome: run.output.passed ? 'pass' : 'fail', blocking: [], red: !run.output.passed }),
    recorded: (c) => ({ outcome: c.legacy.passed ? 'pass' : 'fail', blocking: [], red: !c.legacy.passed }),
    recall: () => async (reference, other) => ({
      reference: reference.red ? 1 : 0,
      matched: reference.red && other.red ? 1 : 0,
    }),
  })
}
