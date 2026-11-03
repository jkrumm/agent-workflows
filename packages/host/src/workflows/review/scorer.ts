import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JUDGE_B_VERSION, JUDGE_VERSION } from '@agent-workflows/capabilities'
import {
  exec,
  GT_LIMIT,
  GtCase,
  type GtFinding,
  gtPath,
  JudgeCalibration,
  type JudgeClass,
  type JudgeInput,
  JudgeOutput,
  KAPPA_BAR,
  normalizePath,
} from '@agent-workflows/eval'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { type ReviewInputValue, ReviewOutput, type ReviewResult } from './schema.ts'

/** How findings are judged: `single`, judge `a` alone (the calibration vouches for it), or `dual`, both judges. */
export type JudgeMode = 'single' | 'dual'

/** The mode and why: the κ and the reason are what the host logs once, when it builds the scorer. */
export type ResolvedMode = { mode: JudgeMode; kappa: number | null; reason: string }

/**
 * The mode the calibration allows (`eval.gt.calibrate`): `single` when `judge-calibration.json` exists, was made for
 * both current judge versions (`JUDGE_VERSION`, `JUDGE_B_VERSION`) and its κ clears `KAPPA_BAR`; otherwise `dual`
 * (missing, unreadable, another version of either judge, κ below the bar or undefined). Reads the disk: call it where
 * the host builds its scorers, never at import.
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

/**
 * The scorer version: judge `a`'s version always, and judge `b`'s too in dual mode (where it decides scores), with the
 * mode, so `compare` refuses to mix modes or judges.
 */
const scorerVersion = (mode: JudgeMode) =>
  mode === 'single'
    ? `2026-11-03.v4+${JUDGE_VERSION}+judges:single`
    : `2026-11-03.v4+${JUDGE_VERSION}+${JUDGE_B_VERSION}+judges:dual`

const PIPELINE = '(review pipeline)'
const GIT_TIMEOUT_MS = 120_000

/** `Partial review: 2/6 reviewers failed` and `All 6 specialist reviewers failed`, as `verdict.ts` writes them. */
function failedShare(review: ReviewResult): number {
  if (/^All \d+ specialist reviewers failed/.test(review.summary)) return 1
  const partial = /^Partial review: (\d+)\/(\d+) reviewers failed/.exec(review.summary)
  if (partial) return Number(partial[1]) / Math.max(1, Number(partial[2]))
  const failed = review.discussions.filter((d) => d.file === PIPELINE && d.angle !== 'synthesis').length
  return failed > 0 ? 1 : 0 // a pipeline discussion without the lead: the share is unknown, count it as all
}

/** No synthesized verdict: the raw synthesizer text was salvaged, or no review ran (provider balance). */
const incomplete = (review: ReviewResult) =>
  review.degraded !== undefined || review.discussions.some((d) => d.file === PIPELINE && d.angle === 'synthesis')

/** REVIEW_OUTPUT v2 as the judge sees it: blocking is `important`, the rest `nit`; pipeline entries are not findings. */
function toFindings(review: ReviewResult): GtFinding[] {
  const tagged = [
    ...review.blocking.map((f) => ({ f, tag: 'important' as const })),
    ...review.improvements.map((f) => ({ f, tag: 'nit' as const })),
    ...review.discussions.map((f) => ({ f, tag: 'nit' as const })),
  ]
  return tagged
    .filter(({ f }) => f.file !== PIPELINE)
    .map(({ f, tag }, index) => ({
      id: String(index),
      tag,
      file: f.file,
      ...(f.line !== undefined && f.line > 0 ? { line: f.line } : {}),
      message: f.message,
    }))
}

type GtBug = Extract<GtCase, { kind: 'bug' }>['bug']
const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1)

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

/** The reviewed commit's diff, read from the owner's checkout: the case tree may be gone when scoring runs. */
async function commitDiff(repo: string, sha: string): Promise<string> {
  const shown = await exec('git', ['show', '--format=', sha], {
    cwd: join(process.env.HOME ?? homedir(), repo), // Bun's homedir() is fixed at start
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (shown.code !== 0) throw new Error(`git show ${sha} in ${repo}: ${shown.stderr.trim()}`)
  return shown.stdout
}

type Judge = NonNullable<Parameters<Scorer['score']>[2]['judge']>

/** One judge seat's classes. Seat `a` sends the input as it always was; seat `b` marks its seat. */
async function judgeFindings(
  reference: GtCase,
  findings: GtFinding[],
  judge: Judge,
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
  const output = JudgeOutput.parse(await judge('eval.judge', input))
  return new Map(output.findings.map((f) => [f.id, { class: f.class, reason: f.reason }]))
}

/**
 * Both judges on every finding: the same class stands, a finding they classify differently is `unclear` (a
 * disagreement on the bug match is no match). Returns how many findings they disagreed on.
 */
async function judgeBoth(
  reference: GtCase,
  findings: GtFinding[],
  judge: Judge,
): Promise<{ judged: Judged; disagreed: number }> {
  const diff = await commitDiff(reference.repo, reference.sha)
  const [a, b] = await Promise.all([
    judgeFindings(reference, findings, judge, 'a', diff),
    judgeFindings(reference, findings, judge, 'b', diff),
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

type Judged = Map<string, { class: JudgeClass; reason: string }>
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

/**
 * The `review` scorer (`docs/review-v2.md` §Metrics). Every score is in [0, 1] or a count; all are recorded only
 * where defined. Structural, always: `valid` (parses as REVIEW_OUTPUT v2, else the rest is 0), `complete` (a
 * synthesized verdict, not a salvaged one or a provider-balance stand-in), `angleSuccess` (1 − the share of reviewers
 * that failed). With a ground-truth case as reference, the judge classifies the findings (`match`, `real`,
 * `not-a-bug`, `nit`, `unclear`); none when the review has no finding. One judge (`a`) when the judges' calibration
 * clears the bar (`judgeModeOf`), else both, and a finding they classify differently is `unclear`; the mode is in the
 * scorer's version and in its notes, with the limit of the ground truth (`GT_LIMIT`). A bug case: `recall` (an
 * important finding matches the bug), `detected` (any finding does), `severityCalibration` (when detected, a matching
 * finding is important). A control: `falseAlarms` (important findings), `clean` (none). Both: `noise` (share of
 * `not-a-bug` findings), `findings`, `important`, `realOther` (findings judged real).
 * `pass`: valid and complete, and a bug case has recall 1, a control is clean. Without a reference (drift): the
 * structural scores only, no judge call.
 */
export function createReviewScorer(resolved: {
  mode: JudgeMode
  kappa: number | null
}): Scorer<ReviewInputValue, GtCase> {
  const { mode, kappa } = resolved
  return {
    version: scorerVersion(mode),
    reference: GtCase,
    async score(_input, output, ctx): Promise<Verdict> {
      const { reference } = ctx
      const parsed = ReviewOutput.safeParse(output)
      if (!parsed.success) {
        const scores: Record<string, number> = { valid: 0, complete: 0, angleSuccess: 0 }
        if (reference?.kind === 'bug') scores.recall = 0
        if (reference?.kind === 'control') Object.assign(scores, { falseAlarms: 0, clean: 0 })
        return {
          scores,
          pass: false,
          feedback: output === null ? 'the run failed' : 'the output is not REVIEW_OUTPUT v2',
        }
      }
      const review = parsed.data
      const angleSuccess = 1 - failedShare(review)
      const complete = incomplete(review) ? 0 : 1
      const scores: Record<string, number> = { valid: 1, complete, angleSuccess }
      const problems: string[] = []
      if (!complete) problems.push('no synthesized verdict')
      if (angleSuccess < 1) problems.push('reviewers failed')
      if (!reference)
        return { scores, pass: complete === 1, ...(problems.length ? { feedback: problems.join('; ') } : {}) }

      const findings = toFindings(review)
      const important = findings.filter((f) => f.tag === 'important')
      const judged: Judged = new Map()
      let note = ''
      if (findings.length > 0) {
        if (!ctx.judge) throw new Error('the review scorer needs a judge with a reference')
        if (mode === 'dual') {
          const both = await judgeBoth(reference, findings, ctx.judge)
          for (const [id, verdict] of both.judged) judged.set(id, verdict)
          note = `judges: dual, ${count(both.disagreed, 'finding')} judged differently, scored unclear`
        } else {
          const diff = await commitDiff(reference.repo, reference.sha)
          for (const [id, verdict] of await judgeFindings(reference, findings, ctx.judge, 'a', diff))
            judged.set(id, verdict)
          note = `judges: single (a), κ ${kappa === null ? 'unknown' : kappa.toFixed(2)} between the judges`
        }
      }
      const classOf = (f: GtFinding) => judged.get(f.id)?.class ?? 'unclear'
      const noisy = findings.filter((f) => classOf(f) === 'not-a-bug').length
      Object.assign(scores, {
        findings: findings.length,
        important: important.length,
        realOther: findings.filter((f) => classOf(f) === 'real').length,
        ...(findings.length > 0 ? { noise: noisy / findings.length } : {}),
      })
      const outcome = reference.kind === 'bug' ? scoreBug(reference.bug, findings, judged) : scoreControl(important)
      Object.assign(scores, outcome.scores)
      if (outcome.feedback) problems.push(outcome.feedback)
      if (note) problems.push(`${note}; limit: ${GT_LIMIT}`)
      const correct = outcome.correct
      const pass = complete === 1 && correct
      return { scores, pass, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
    },
  }
}

/**
 * The scorer the host registers: its mode from the calibration on disk, logged once with the reason. Called where the
 * host builds its workflows (the review module), once per build; the mode then holds for the process, so no run's
 * scorer version changes under it, and a new calibration takes effect at the next host start.
 */
export function resolveReviewScorer(options: {
  env?: Record<string, string | undefined>
  log?: (message: string) => void
}): Scorer<ReviewInputValue, GtCase> {
  const resolved = judgeModeOf(options.env)
  const scorer = createReviewScorer(resolved)
  const log = options.log ?? ((message: string) => console.info(message))
  log(`[agw-review-scorer] ${scorer.version}: ${resolved.reason}`)
  return scorer
}

/** The scorer where nothing resolved a mode: both judges, which needs no calibration and reads no file. */
export const reviewScorer = createReviewScorer({ mode: 'dual', kappa: null })
