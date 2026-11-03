import { existsSync, readFileSync } from 'node:fs'
import { JUDGE_B_VERSION, JUDGE_VERSION } from '@agent-workflows/capabilities'
import {
  GT_LIMIT,
  type GtCase,
  type GtFinding,
  gtPath,
  JudgeCalibration,
  type JudgeClass,
  type JudgeInput,
  JudgeOutput,
  KAPPA_BAR,
} from '@agent-workflows/eval'
import type { OutputFindingValue } from '../../review/schema.ts'

/** How findings are judged: `single`, judge `a` alone (the calibration vouches for it), or `dual`, both judges. */
export type JudgeMode = 'single' | 'dual'

/** The mode and why: the κ and the reason are what the run reports. */
export type ResolvedMode = { mode: JudgeMode; kappa: number | null; reason: string }

/** One judge call, bound to the step that makes it (its call context). */
export type JudgeFn = (input: JudgeInput) => Promise<JudgeOutput>

/**
 * The mode the calibration allows (`eval.gt.calibrate`): `single` when `judge-calibration.json` exists, was made for
 * both current judge versions and its κ clears `KAPPA_BAR`; otherwise `dual` (missing, unreadable, another version of
 * either judge, κ below the bar or undefined). Reads the disk.
 */
export function judgeModeOf(env: Record<string, string | undefined> = process.env): ResolvedMode {
  const path = gtPath('judge-calibration.json', env)
  const dual = (reason: string, kappa: number | null = null): ResolvedMode => ({ mode: 'dual', kappa, reason })
  let raw: string
  try {
    if (!existsSync(path)) return dual('no judge-calibration.json')
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return dual(`judge-calibration.json unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return dual('judge-calibration.json is not JSON')
  }
  const parsed = JudgeCalibration.safeParse(json)
  if (!parsed.success) return dual('judge-calibration.json does not parse (an older format?)')
  const { kappa, judgeVersions } = parsed.data
  if (judgeVersions.a !== JUDGE_VERSION || judgeVersions.b !== JUDGE_B_VERSION)
    return dual(
      `calibrated for judges ${judgeVersions.a} + ${judgeVersions.b}, current are ${JUDGE_VERSION} + ${JUDGE_B_VERSION}`,
      kappa,
    )
  if (kappa === null) return dual('κ is undefined (the judges only ever gave one answer)')
  if (kappa < KAPPA_BAR) return dual(`κ ${kappa.toFixed(3)} is below the bar ${KAPPA_BAR}`, kappa)
  return { mode: 'single', kappa, reason: `κ ${kappa.toFixed(3)} clears the bar ${KAPPA_BAR}` }
}

/** The scorer version: judge `a`'s always, judge `b`'s too in dual mode, with the mode, so runs of other modes never mix. */
export const scorerVersion = (mode: JudgeMode) =>
  mode === 'single'
    ? `2026-11-03.v4+${JUDGE_VERSION}+judges:single`
    : `2026-11-03.v4+${JUDGE_VERSION}+${JUDGE_B_VERSION}+judges:dual`

type GtBug = Extract<GtCase, { kind: 'bug' }>['bug']
const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1)
const normalizePath = (file: string) =>
  file
    .trim()
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')

/** v4 findings as the judge sees them: the claim and its failure scenario; `line` null is no line. */
export function toFindings(findings: readonly OutputFindingValue[]): GtFinding[] {
  return findings.map((f) => ({
    id: f.id,
    tag: f.tag,
    file: f.file,
    ...(f.line !== null && f.line > 0 ? { line: f.line } : {}),
    message: f.failureScenario ? `${f.message}\n\nFailure scenario: ${f.failureScenario}` : f.message,
  }))
}

/**
 * The ids the judge may call a `match`. Cheap and deterministic: the matcher only preselects, never decides. A finding
 * passes when it sits in the bug's file (paths normalized) or its message names that file's basename.
 */
function preselect(bug: GtBug, findings: GtFinding[]): string[] {
  const { file } = bug.location
  const name = basename(file)
  return findings
    .filter((f) => normalizePath(f.file) === normalizePath(file) || f.message.includes(name))
    .map((f) => f.id)
}

type Judged = Map<string, { class: JudgeClass; reason: string }>

async function judgeSeat(
  reference: GtCase,
  findings: GtFinding[],
  judge: JudgeFn,
  seat: 'a' | 'b',
  diff: string,
): Promise<Judged> {
  const input: JudgeInput = {
    caseId: reference.id,
    bug: reference.kind === 'bug' ? { location: reference.bug.location, description: reference.bug.description } : null,
    findings,
    preselected: reference.kind === 'bug' ? preselect(reference.bug, findings) : [],
    diff,
    ...(seat === 'b' ? { seat } : {}),
  }
  const output = JudgeOutput.parse(await judge(input))
  return new Map(output.findings.map((f) => [f.id, { class: f.class, reason: f.reason }]))
}

/** Both judges on every finding: the same class stands, a finding they classify differently is `unclear`. */
async function judgeBoth(
  reference: GtCase,
  findings: GtFinding[],
  judge: JudgeFn,
  diff: string,
): Promise<{ judged: Judged; disagreed: number }> {
  const [a, b] = await Promise.all([
    judgeSeat(reference, findings, judge, 'a', diff),
    judgeSeat(reference, findings, judge, 'b', diff),
  ])
  const judged: Judged = new Map()
  let disagreed = 0
  for (const [id, one] of a) {
    const other = b.get(id)
    if (other && other.class === one.class) judged.set(id, one)
    else {
      disagreed++
      judged.set(id, {
        class: 'unclear',
        reason: `the judges disagree (a: ${one.class}, b: ${other?.class ?? 'no answer'}); a: ${one.reason}`,
      })
    }
  }
  return { judged, disagreed }
}

type Outcome = { scores: Record<string, number>; correct: boolean; feedback: string }

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** A bug case: `recall` needs an important finding judged `match`; a match that is only a nit is `detected`. */
function scoreBug(bug: GtBug, findings: GtFinding[], judged: Judged): Outcome {
  const matched = findings.filter((f) => judged.get(f.id)?.class === 'match')
  const hit = matched.find((f) => f.tag === 'important')
  const shown = hit ?? matched[0]
  return {
    scores: {
      recall: hit ? 1 : 0,
      detected: shown ? 1 : 0,
      ...(shown ? { severityCalibration: hit ? 1 : 0 } : {}),
    },
    correct: hit !== undefined,
    feedback: shown
      ? `matched finding ${shown.id}${hit ? '' : ' (only as a nit)'}: ${judged.get(shown.id)?.reason}`
      : `missed: ${bug.bugClass} at ${bug.location.file}:${bug.location.startLine}`,
  }
}

/** A control: every important finding is a false alarm. */
function scoreControl(important: GtFinding[]): Outcome {
  const clean = important.length === 0
  return {
    scores: { falseAlarms: important.length, clean: clean ? 1 : 0 },
    correct: clean,
    feedback: clean ? '' : `false alarms: ${count(important.length, 'important finding')}`,
  }
}

export type CaseScore = {
  scores: Record<string, number>
  pass: boolean
  feedback: string
  /** The judge's class per finding id (an unjudged finding: `unclear`). */
  classes: Record<string, JudgeClass>
}

/**
 * The recall scorer (`docs/review-v2.md` §Metrics) on review v4's output. The judge classifies the findings (`match`,
 * `real`, `not-a-bug`, `nit`, `unclear`); none is asked for when the review has no finding. One judge (`a`) when the
 * calibration clears the bar, else both (`mode`), and a finding they classify differently is `unclear`. A bug case:
 * `recall` (an important finding matches the bug), `detected` (any finding does), `severityCalibration` (when
 * detected, a matching finding is important). A control: `falseAlarms` (important findings), `clean` (none). Both:
 * `noise` (share of `not-a-bug` findings), `findings`, `important`, `realOther` (findings judged real). `diff` is the
 * reviewed commit's `git show --format=`. The feedback carries the ground truth's limit (`GT_LIMIT`).
 */
export async function scoreCase(args: {
  reference: GtCase
  findings: readonly OutputFindingValue[]
  judge: JudgeFn
  mode: ResolvedMode
  diff: string
}): Promise<CaseScore> {
  const { reference, judge, mode } = args
  const findings = toFindings(args.findings)
  const important = findings.filter((f) => f.tag === 'important')
  const judged: Judged = new Map()
  let note = ''
  if (findings.length > 0) {
    if (mode.mode === 'dual') {
      const both = await judgeBoth(reference, findings, judge, args.diff)
      for (const [id, verdict] of both.judged) judged.set(id, verdict)
      note = `judges: dual, ${count(both.disagreed, 'finding')} judged differently, scored unclear`
    } else {
      for (const [id, verdict] of await judgeSeat(reference, findings, judge, 'a', args.diff)) judged.set(id, verdict)
      note = `judges: single (a), κ ${mode.kappa === null ? 'unknown' : mode.kappa.toFixed(2)} between the judges`
    }
  }
  const classOf = (f: GtFinding): JudgeClass => judged.get(f.id)?.class ?? 'unclear'
  const noisy = findings.filter((f) => classOf(f) === 'not-a-bug').length
  const outcome = reference.kind === 'bug' ? scoreBug(reference.bug, findings, judged) : scoreControl(important)
  const scores: Record<string, number> = {
    findings: findings.length,
    important: important.length,
    realOther: findings.filter((f) => classOf(f) === 'real').length,
    ...(findings.length > 0 ? { noise: noisy / findings.length } : {}),
    ...outcome.scores,
  }
  const feedback = [outcome.feedback, note ? `${note}; limit: ${GT_LIMIT}` : ''].filter(Boolean).join('; ')
  return {
    scores,
    pass: outcome.correct,
    feedback,
    classes: Object.fromEntries(findings.map((f) => [f.id, classOf(f)])),
  }
}
