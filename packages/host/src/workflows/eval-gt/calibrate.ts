import type { CallOptions } from '@agent-workflows/capabilities'
import { JUDGE_B_VERSION, JUDGE_VERSION } from '@agent-workflows/capabilities'
import {
  agreement,
  type Confusion,
  cohenKappa,
  evalDir,
  GT_DIR,
  GT_LIMIT,
  GtCase,
  type JudgeCalibration,
  type JudgeClass,
  JudgeBRecord,
  JudgeInput,
  JudgeOutput,
  KAPPA_BAR,
  kappaCI,
  readCases,
  samplePairs,
} from '@agent-workflows/eval'
import { resolveRoute } from '@agent-workflows/routes'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendRecord, readRecords } from '../eval-mine/files.ts'
import { seatAnswer } from '../eval-mine/label.ts'
import type { JudgeRun, JudgeRunReader } from './judge-runs.ts'

/** The one capability calibration calls, as judge `b`; any registry that serves `eval.judge` fits. */
export interface JudgeCaller {
  call(id: 'eval.judge', input: JudgeInput, options: CallOptions): Promise<JudgeOutput>
}

export interface CalibrateDeps {
  env: Record<string, string | undefined>
  judgeRuns: JudgeRunReader
  judge: JudgeCaller
  /**
   * The workflow versions of `cap.eval.judge` runs that asked judge `a` under the current `JUDGE_VERSION`. The journal
   * records a hash of the capability's definition per run, not the judge's pinned version: the current hash, and the
   * earlier ones known to ask the very same prompt, schema and route (see `module.ts`). A run of any other version is
   * not re-asked: its judge-`a` answer may come from a judge that no longer exists.
   */
  judgeRunVersions: readonly string[]
  /** Where an unreadable line of `judge-b.jsonl` is reported. Default: the console. */
  warn?: (message: string) => void
}

export interface CalibrateRequest {
  evalRuns: string[]
  pairs: number
  seed: number
}

/** The caller's input is wrong (no ground truth, no judge call to compare): not an outage, not worth a retry. */
export class CalibrateInputError extends Error {}

/** Judge runs left out of the pairs, by why. */
export type Skipped = { unusable: number; unknownCase: number; otherSeat: number; otherVersion: number }

type Pair = { runId: string; findingId: string; aMatch: boolean }
type AskedRun = { input: JudgeInput; output: JudgeOutput }

export interface CalibrationPlan {
  /** The judge-a calls to re-ask on judge `b`, by run id. */
  runs: Map<string, AskedRun>
  pairs: Pair[]
  positives: number
  negatives: number
  skipped: Skipped
  /** Run ids whose judge-`b` answer is already in `judge-b.jsonl`: not asked again. */
  cached: Set<string>
  notes: string[]
  /** Rough size of the judge-b calls (prompt characters, findings), for the estimate. */
  load: { chars: number; findings: number }
}

/** Judge `b`'s answers on file for the current `JUDGE_B_VERSION`, by judge-`a` run id (the latest line wins). */
function judgeBAnswers(env: CalibrateDeps['env'], warn?: (message: string) => void): Map<string, JudgeOutput> {
  const out = new Map<string, JudgeOutput>()
  const report = warn ?? ((message: string) => console.warn(`[agw-eval-gt] ${message}`))
  for (const record of readRecords('judge-b.jsonl', JudgeBRecord, env, report)) {
    if (record.judgeBVersion === JUDGE_B_VERSION) out.set(record.runId, record.output)
  }
  return out
}

const CLASSES = ['real', 'not-a-bug', 'nit', 'unclear'] as const
const isMatch = (c: JudgeClass) => c === 'match'

/**
 * The pairs: every finding of a done judge-`a` `cap.eval.judge` run on a mined bug case that judge `a` called a match
 * (positive), or did not though it was preselected (a plausible wrong finding: right file, wrong defect; negative).
 * Runs of judge `b` (`seat: 'b'`, the scorer's dual mode) and runs of a version other than `deps.judgeRunVersions` are
 * skipped and counted. Half the budget
 * each side, seeded; when positives fall short, negatives fill up. Nothing is called.
 */
export async function planCalibration(deps: CalibrateDeps, request: CalibrateRequest): Promise<CalibrationPlan> {
  const notes: string[] = []
  const path = join(evalDir(deps.env), GT_DIR, 'cases.jsonl')
  const known = new Set(
    (existsSync(path) ? readCases(path, GtCase) : []).flatMap((c) => (c.kind === 'bug' ? [c.id] : [])),
  )
  if (known.size === 0) throw new CalibrateInputError('cases.jsonl has no mined bug case: mine and label first')

  const byRun = new Map<string, AskedRun>()
  const positives: Pair[] = []
  const negatives: Pair[] = []
  const skipped: Skipped = { unusable: 0, unknownCase: 0, otherSeat: 0, otherVersion: 0 }
  const runs: JudgeRun[] = await deps.judgeRuns.judgeRuns(request.evalRuns)
  for (const run of runs) {
    const input = JudgeInput.safeParse(run.input)
    const output = JudgeOutput.safeParse(run.output)
    if (!input.success || !output.success || !input.data.bug) {
      skipped.unusable++
      continue
    }
    if (input.data.seat !== undefined && input.data.seat !== 'a') {
      skipped.otherSeat++
      continue
    }
    if (run.version === null || !deps.judgeRunVersions.includes(run.version)) {
      skipped.otherVersion++
      continue
    }
    if (!known.has(input.data.caseId)) {
      skipped.unknownCase++
      continue
    }
    byRun.set(run.runId, { input: input.data, output: output.data })
    const classes = new Map(output.data.findings.map((f) => [f.id, f.class]))
    for (const finding of input.data.findings) {
      const judged = classes.get(finding.id)
      if (!judged) continue
      const match = isMatch(judged)
      // Only preselected non-matches: right file, plausible, a different defect (the hard negatives the bar needs).
      if (!match && !input.data.preselected.includes(finding.id)) continue
      ;(match ? positives : negatives).push({ runId: run.runId, findingId: finding.id, aMatch: match })
    }
  }
  if (skipped.unusable)
    notes.push(`${skipped.unusable} judge runs skipped: no known bug, or input/output not a judge call`)
  if (skipped.otherSeat) notes.push(`${skipped.otherSeat} judge runs skipped: not judge a (a dual-mode judge b call)`)
  if (skipped.otherVersion)
    notes.push(`${skipped.otherVersion} judge runs skipped: made by another version of the judge capability`)
  if (skipped.unknownCase) notes.push(`${skipped.unknownCase} judge runs skipped: their case is not in cases.jsonl`)

  const sample = samplePairs({ positives, negatives, total: request.pairs, seed: request.seed })
  if (sample.shortfall.positives > 0)
    notes.push(
      `${positives.length} judge-positive pairs exist for a quota of ${Math.floor(request.pairs / 2)}; all are used and judge-negative pairs fill the rest`,
    )
  if (sample.shortfall.negatives > 0)
    notes.push(`only ${sample.positives.length + sample.negatives.length} of ${request.pairs} requested pairs exist`)
  const pairs = [...sample.positives, ...sample.negatives]
  if (pairs.length === 0)
    throw new CalibrateInputError(`no judge pair to compare${notes.length ? ` (${notes.join('; ')})` : ''}`)

  const asked = new Map([...new Set(pairs.map((p) => p.runId))].map((id) => [id, byRun.get(id) as AskedRun]))
  const cached = new Set([...judgeBAnswers(deps.env, deps.warn).keys()].filter((runId) => asked.has(runId)))
  const load = { chars: 0, findings: 0 }
  for (const [runId, { input }] of asked) {
    if (cached.has(runId)) continue
    load.chars += JSON.stringify(input).length
    load.findings += input.findings.length
  }
  return {
    runs: asked,
    pairs,
    positives: sample.positives.length,
    negatives: sample.negatives.length,
    skipped,
    cached,
    notes,
    load,
  }
}

const CHARS_PER_TOKEN = 4
const OUTPUT_TOKENS_PER_FINDING = 80
const PROMPT_OVERHEAD_TOKENS = 900

/** Judge `b`'s cost for the plan (the calls still to make) at the route's rate: prompt size over four characters per token, a short reason per finding. */
export function estimateCost(plan: CalibrationPlan): number | null {
  const { rate } = resolveRoute('eval.judge.b')
  if (!rate) return null
  const input = plan.load.chars / CHARS_PER_TOKEN + (plan.runs.size - plan.cached.size) * PROMPT_OVERHEAD_TOKENS
  const output = plan.load.findings * OUTPUT_TOKENS_PER_FINDING
  return (input * rate.inputPerM + output * rate.outputPerM) / 1_000_000
}

export interface CalibrationOptions {
  callContext: CallOptions
  signal: AbortSignal
  progress: () => void
  now: () => Date
  concurrency: number
  evalRuns: string[]
}

export type CalibrationResult = {
  calibration: JudgeCalibration
  /** Judge runs whose re-ask failed with an answer (an unusable output): left out, their pairs not compared. */
  skippedRuns: number
  /** Judge-`b` calls made this run, and answers taken from `judge-b.jsonl`. */
  asked: number
  reused: number
  notes: string[]
}

/**
 * Re-asks judge `b` on exactly the recorded judge-a inputs, `concurrency` at a time, and compares per pair. Each answer
 * is appended to `judge-b.jsonl` as it arrives and a rerun asks only the runs without one, so a stop (no credit, an
 * outage) keeps what was paid for.
 */
export async function runCalibration(
  deps: CalibrateDeps,
  plan: CalibrationPlan,
  options: CalibrationOptions,
): Promise<CalibrationResult> {
  const stored = judgeBAnswers(deps.env, deps.warn)
  const answers = new Map<string, JudgeOutput>()
  for (const runId of plan.runs.keys()) {
    const kept = stored.get(runId)
    if (kept) answers.set(runId, kept)
  }
  const reused = answers.size
  let asked = 0
  const queue = [...plan.runs.entries()].filter(([runId]) => !answers.has(runId))
  let next = 0
  let failure: { error: unknown } | null = null
  const skipped: string[] = []
  const worker = async () => {
    while (failure === null && next < queue.length) {
      const [runId, { input }] = queue[next++] as (typeof queue)[number]
      try {
        options.signal.throwIfAborted()
        const output = await deps.judge.call('eval.judge', { ...input, seat: 'b' }, options.callContext)
        appendRecord(
          'judge-b.jsonl',
          JudgeBRecord,
          { runId, judgeBVersion: JUDGE_B_VERSION, at: options.now().toISOString(), output },
          deps.env,
        )
        answers.set(runId, output)
        asked++
        options.progress()
      } catch (error) {
        // An unusable answer is the judge's about this input; anything else (no credit, an outage, a cancel) stops.
        if (!options.signal.aborted && seatAnswer(error) !== null) skipped.push(runId)
        else failure ??= { error: options.signal.aborted ? (options.signal.reason ?? error) : error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, worker))
  if (failure) throw (failure as { error: unknown }).error

  const confusion: Confusion = { yy: 0, yn: 0, ny: 0, nn: 0 }
  const classOf = (runId: string, findingId: string) =>
    answers.get(runId)?.findings.find((f) => f.id === findingId)?.class
  for (const pair of plan.pairs) {
    const b = classOf(pair.runId, pair.findingId)
    if (b === undefined) continue
    const bMatch = isMatch(b)
    if (pair.aMatch) confusion[bMatch ? 'yy' : 'yn']++
    else confusion[bMatch ? 'ny' : 'nn']++
  }

  // Classes of the findings neither judge called a match, over every finding of the re-asked runs.
  const classes: Record<string, Record<string, number>> = {}
  let classN = 0
  let classSame = 0
  for (const [runId, { output }] of plan.runs) {
    const b = answers.get(runId)
    if (!b) continue
    const bClasses = new Map(b.findings.map((f) => [f.id, f.class]))
    for (const { id, class: aClass } of output.findings) {
      const bClass = bClasses.get(id)
      if (!bClass || isMatch(aClass) || isMatch(bClass)) continue
      classes[aClass] ??= {}
      classes[aClass][bClass] = (classes[aClass][bClass] ?? 0) + 1
      classN++
      if (aClass === bClass) classSame++
    }
  }
  for (const a of CLASSES) classes[a] ??= {}

  const n = confusion.yy + confusion.yn + confusion.ny + confusion.nn
  const kappa = cohenKappa(confusion)
  const interval = kappaCI(confusion)
  const models = (side: 'a' | 'b') => [
    ...new Set(
      [...plan.runs.entries()].flatMap(([runId, { output }]) => {
        const model = side === 'a' ? output.model : answers.get(runId)?.model
        return model ? [model] : []
      }),
    ),
  ]
  const notes = [...plan.notes]
  if (skipped.length > 0) notes.push(`${skipped.length} judge runs skipped: judge b gave no usable answer`)
  return {
    skippedRuns: skipped.length,
    asked,
    reused,
    notes,
    calibration: {
      at: options.now().toISOString(),
      limit: GT_LIMIT,
      judgeVersions: { a: JUDGE_VERSION, b: JUDGE_B_VERSION },
      judgeModels: { a: models('a'), b: models('b') },
      evalRuns: options.evalRuns,
      n,
      agreement: agreement(confusion),
      kappa,
      ci95: interval ? { lo: interval.lo, hi: interval.hi } : null,
      bar: KAPPA_BAR,
      met: kappa !== null && kappa >= KAPPA_BAR,
      confusion,
      classes: { n: classN, agreement: classN ? classSame / classN : null, confusion: classes },
    },
  }
}
