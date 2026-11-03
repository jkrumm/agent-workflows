import type { CallOptions } from '@agent-workflows/capabilities'
import { JUDGE_VERSION } from '@agent-workflows/capabilities'
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
}

export interface CalibrateRequest {
  evalRuns: string[]
  pairs: number
  seed: number
}

/** The caller's input is wrong (no ground truth, no judge call to compare): not an outage, not worth a retry. */
export class CalibrateInputError extends Error {}

type Pair = { runId: string; findingId: string; aMatch: boolean }
type AskedRun = { input: JudgeInput; output: JudgeOutput }

export interface CalibrationPlan {
  /** The judge-a calls to re-ask on judge `b`, by run id. */
  runs: Map<string, AskedRun>
  pairs: Pair[]
  positives: number
  negatives: number
  notes: string[]
  /** Rough size of the judge-b calls (prompt characters, findings), for the estimate. */
  load: { chars: number; findings: number }
}

const CLASSES = ['real', 'not-a-bug', 'nit', 'unclear'] as const
const isMatch = (c: JudgeClass) => c === 'match'

/**
 * The pairs: every finding of a done `cap.eval.judge` run on a mined bug case that judge `a` called a match (positive),
 * or did not though it was preselected (a plausible wrong finding: right file, wrong defect; negative). Half the budget
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
  let unusable = 0
  let unknownCase = 0
  const runs: JudgeRun[] = await deps.judgeRuns.judgeRuns(request.evalRuns)
  for (const run of runs) {
    const input = JudgeInput.safeParse(run.input)
    const output = JudgeOutput.safeParse(run.output)
    if (!input.success || !output.success || !input.data.bug) {
      unusable++
      continue
    }
    if (!known.has(input.data.caseId)) {
      unknownCase++
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
  if (unusable) notes.push(`${unusable} judge runs skipped: no known bug, or input/output not a judge call`)
  if (unknownCase) notes.push(`${unknownCase} judge runs skipped: their case is not in cases.jsonl`)

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
  const load = { chars: 0, findings: 0 }
  for (const { input } of asked.values()) {
    load.chars += JSON.stringify(input).length
    load.findings += input.findings.length
  }
  return {
    runs: asked,
    pairs,
    positives: sample.positives.length,
    negatives: sample.negatives.length,
    notes,
    load,
  }
}

const CHARS_PER_TOKEN = 4
const OUTPUT_TOKENS_PER_FINDING = 80
const PROMPT_OVERHEAD_TOKENS = 900

/** Judge `b`'s cost for the plan at the route's rate: prompt size over four characters per token, a short reason per finding. */
export function estimateCost(plan: CalibrationPlan): number | null {
  const { rate } = resolveRoute('eval.judge.b')
  if (!rate) return null
  const input = plan.load.chars / CHARS_PER_TOKEN + plan.runs.size * PROMPT_OVERHEAD_TOKENS
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
  notes: string[]
}

/** Re-asks judge `b` on exactly the recorded judge-a inputs, `concurrency` at a time, and compares per pair. */
export async function runCalibration(
  deps: CalibrateDeps,
  plan: CalibrationPlan,
  options: CalibrationOptions,
): Promise<CalibrationResult> {
  const answers = new Map<string, JudgeOutput>()
  const queue = [...plan.runs.entries()]
  let next = 0
  let failure: { error: unknown } | null = null
  const skipped: string[] = []
  const worker = async () => {
    while (failure === null && next < queue.length) {
      const [runId, { input }] = queue[next++] as (typeof queue)[number]
      try {
        options.signal.throwIfAborted()
        answers.set(runId, await deps.judge.call('eval.judge', { ...input, seat: 'b' }, options.callContext))
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
    notes,
    calibration: {
      at: options.now().toISOString(),
      limit: GT_LIMIT,
      judgeVersion: JUDGE_VERSION,
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
