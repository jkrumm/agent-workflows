import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  classifyPair,
  exec,
  GtCase,
  type GtFinding,
  type JudgeClass,
  type JudgeInput,
  JudgeOutput,
} from '@agent-workflows/eval'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { type ReviewInputValue, ReviewOutput, type ReviewResult } from './schema.ts'

// replaced at merge: import from eval-judge.ts
const JUDGE_VERSION = 'pending'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const REVIEW_SCORER_VERSION = `2026-11-02.v3+${JUDGE_VERSION}`

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

const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1)

/**
 * The ids the judge may call a `match`. Cheap and deterministic: the matcher only preselects, never decides. A finding
 * passes when it sits in the bug's file (`classifyPair` on line-less, message-less sides is `none` exactly when the
 * normalized paths differ, so it is the one path normalizer; any pair in the same file is `not none`, so a message
 * or line test on top would never narrow it) or its message names that file.
 */
function preselect(bug: Extract<GtCase, { kind: 'bug' }>['bug'], findings: GtFinding[]): string[] {
  const { file } = bug.location
  const name = basename(file)
  const sameFile = (other: string) => classifyPair({ file: other, message: '' }, { file, message: '' }).kind !== 'none'
  return findings.filter((f) => sameFile(f.file) || f.message.includes(name)).map((f) => f.id)
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

async function judgeFindings(
  reference: GtCase,
  findings: GtFinding[],
  judge: NonNullable<Parameters<Scorer['score']>[2]['judge']>,
): Promise<Map<string, { class: JudgeClass; reason: string }>> {
  const input: JudgeInput = {
    caseId: reference.id,
    bug: reference.kind === 'bug' ? { location: reference.bug.location, description: reference.bug.description } : null,
    findings,
    preselected: reference.kind === 'bug' ? preselect(reference.bug, findings) : [],
    diff: await commitDiff(reference.repo, reference.sha),
  }
  const output = JudgeOutput.parse(await judge('eval.judge', input))
  return new Map(output.findings.map((f) => [f.id, { class: f.class, reason: f.reason }]))
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * The `review` scorer (`docs/review-v2.md` §Metrics). Every score is in [0, 1] or a count; all are recorded only
 * where defined. Structural, always: `valid` (parses as REVIEW_OUTPUT v2, else the rest is 0), `complete` (a
 * synthesized verdict, not a salvaged one or a provider-balance stand-in), `angleSuccess` (1 − the share of reviewers
 * that failed). With a ground-truth case as reference, one `eval.judge` call classifies the findings
 * (`match`, `real`, `not-a-bug`, `nit`, `unclear`); none when the review has no finding. A bug case: `recall` (an
 * important finding matches the bug), `detected` (any finding does), `severityCalibration` (when detected, a matching
 * finding is important). A control: `falseAlarms` (important findings), `clean` (none). Both: `noise` (share of
 * `not-a-bug` findings), `findings`, `important`, `realOther` (findings judged real: owner-confirmable bug cases).
 * `pass`: valid and complete, and a bug case has recall 1, a control is clean. Without a reference (drift): the
 * structural scores only, no judge call.
 */
export const reviewScorer: Scorer<ReviewInputValue, GtCase> = {
  version: REVIEW_SCORER_VERSION,
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
    const judged = new Map<string, { class: JudgeClass; reason: string }>()
    if (findings.length > 0) {
      if (!ctx.judge) throw new Error('the review scorer needs a judge with a reference')
      for (const [id, verdict] of await judgeFindings(reference, findings, ctx.judge)) judged.set(id, verdict)
    }
    const classOf = (f: GtFinding) => judged.get(f.id)?.class ?? 'unclear'
    const matched = findings.filter((f) => classOf(f) === 'match')
    const notABug = findings.filter((f) => classOf(f) === 'not-a-bug')

    scores.findings = findings.length
    scores.important = important.length
    scores.realOther = findings.filter((f) => classOf(f) === 'real').length
    if (findings.length > 0) scores.noise = notABug.length / findings.length

    let correct: boolean
    if (reference.kind === 'bug') {
      const hit = matched.find((f) => f.tag === 'important')
      scores.recall = hit ? 1 : 0
      scores.detected = matched.length > 0 ? 1 : 0
      if (matched.length > 0) scores.severityCalibration = hit ? 1 : 0
      correct = hit !== undefined
      const shown = hit ?? matched[0]
      const { location, bugClass } = reference.bug
      problems.push(
        shown
          ? `matched finding ${shown.id}${shown.tag === 'nit' ? ' (only as a nit)' : ''}: ${judged.get(shown.id)?.reason}`
          : `missed: ${bugClass} at ${location.file}:${location.startLine}`,
      )
    } else {
      scores.falseAlarms = important.length
      scores.clean = important.length === 0 ? 1 : 0
      correct = important.length === 0
      if (!correct) problems.push(`false alarms: ${count(important.length, 'important finding')}`)
    }
    const pass = complete === 1 && correct
    return { scores, pass, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}
