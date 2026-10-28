import { ESCALATION_CATEGORIES, REVIEW_SCHEMA_VERSION, type ReviewResult, type Synthesis } from './schema.ts'

/** Improvements the verdict keeps; the synthesis prompt asks for the same cap. */
export const MAX_IMPROVEMENTS = 5

const PIPELINE = '(review pipeline)'

type Outcome = Synthesis['outcome']
export type FailedReviewer = { angle: string; failureReason: string | null }

/**
 * The outcome, derived from the lists and never trusted from the model: `needs-human` when an owner decision is
 * pending or a reviewer did not run, else `actionable` only for a blocking finding, else `clean`. Improvements and
 * test gaps are optional follow-ups, so they never keep a review from being clean (a "fix and re-review until clean"
 * loop must terminate).
 */
export function deriveOutcome(
  verdict: { blocking: readonly unknown[]; discussions: readonly unknown[] },
  failedCount: number,
): Outcome {
  if (failedCount > 0 || verdict.discussions.length > 0) return 'needs-human'
  return verdict.blocking.length > 0 ? 'actionable' : 'clean'
}

/**
 * The code-side rules on the parsed synthesis: improvements capped at five (the first five, the model ranks by value),
 * every failed reviewer gets its `(review pipeline)` discussion and a "Partial review" lead, and the outcome comes
 * from `deriveOutcome`. Returns a new verdict; `overridden` carries the model's outcome when code changed it.
 */
export function applyVerdictRules(
  model: Synthesis,
  failed: readonly FailedReviewer[],
  totalReviewers: number,
): { verdict: Synthesis; overridden: { from: Outcome; to: Outcome } | null } {
  const dropped = model.improvements.length - MAX_IMPROVEMENTS
  const improvements = dropped > 0 ? model.improvements.slice(0, MAX_IMPROVEMENTS) : model.improvements
  let summary =
    dropped > 0
      ? `${model.summary} +${dropped} lower-value improvement${dropped === 1 ? '' : 's'} omitted`
      : model.summary
  const discussions = [...model.discussions]
  for (const reviewer of failed) {
    if (discussions.some((d) => d.file === PIPELINE && d.angle === reviewer.angle)) continue
    discussions.push({
      file: PIPELINE,
      message: `${reviewer.angle} session failed: ${reviewer.failureReason} — this angle did not actually review the diff.`,
      angle: reviewer.angle,
    })
  }
  if (failed.length > 0 && !summary.startsWith('Partial review')) {
    summary = `Partial review: ${failed.length}/${totalReviewers} reviewers failed (${failed.map((r) => r.angle).join(', ')}). ${summary}`
  }
  const outcome = deriveOutcome({ blocking: model.blocking, discussions }, failed.length)
  const verdict: Synthesis = { ...model, improvements, discussions, summary, outcome }
  // A failed reviewer is the `blocker` reason unless the model already named an owner reason.
  if (failed.length > 0 && !verdict.escalationCategory) verdict.escalationCategory = 'blocker'
  // The category rides only on `needs-human`.
  if (verdict.outcome !== 'needs-human') delete verdict.escalationCategory
  return { verdict, overridden: model.outcome === outcome ? null : { from: model.outcome, to: outcome } }
}

/**
 * Runs before the strict schema: a near-miss ("Data Loss", "other-people") is coerced and an unknown value dropped,
 * so one bad enum cannot fail a synthesis into the salvage path.
 */
export function coerceEscalationCategory(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('escalationCategory' in raw)) return raw
  const { escalationCategory, ...rest } = raw as Record<string, unknown>
  const category =
    typeof escalationCategory === 'string'
      ? escalationCategory
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : ''
  return (ESCALATION_CATEGORIES as readonly string[]).includes(category)
    ? { ...rest, escalationCategory: category }
    : rest
}

export function cleanVerdict(summary: string): ReviewResult {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    outcome: 'clean',
    blocking: [],
    improvements: [],
    discussions: [],
    testGaps: [],
    summary,
  }
}

const BALANCE_HINT = {
  file: PIPELINE,
  message: 'provider balance exhausted — review in-session with /code-review on your own Claude',
  angle: 'pipeline',
}

/**
 * The reviewers ran but the synthesis was refused on provider balance (its fallback included): their findings are kept
 * unstructured, as the salvage keeps a synthesis that did not serialize, and the verdict carries the degrade and the
 * in-session hint. `needs-human` with `spend`, never approval.
 */
export function balanceSalvagedVerdict(
  reviewerFindings: string,
  failed: readonly FailedReviewer[],
  totalReviewers: number,
): ReviewResult {
  const salvaged = salvagedVerdict(reviewerFindings, failed, totalReviewers)
  const partial =
    failed.length > 0
      ? `Partial review: ${failed.length}/${totalReviewers} reviewers failed (${failed.map((r) => r.angle).join(', ')}). `
      : ''
  return {
    ...salvaged,
    discussions: [
      ...salvaged.discussions.filter((d) => d.angle !== 'synthesis'),
      {
        file: PIPELINE,
        message:
          'The synthesis was refused: provider balance exhausted, fallback route included. The reviewers DID run; ' +
          `their findings, unstructured:\n\n${reviewerFindings.trim().slice(0, 6000)}`,
        angle: 'synthesis',
      },
      BALANCE_HINT,
    ],
    escalationCategory: 'spend',
    summary: `${partial}Review ran ${totalReviewers} reviewers but the synthesis was refused (provider balance exhausted). Their findings are in the discussions; review in-session with /code-review. Treat as needs-human.`,
    degraded: 'provider_balance',
  }
}

/**
 * The model-backed steps failed on provider balance, the routes' fallbacks included: no review ran, and the caller
 * reviews in its own session instead. `needs-human` with `spend`, never approval.
 */
export function balanceDegradedVerdict(failed: readonly FailedReviewer[]): ReviewResult {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    outcome: 'needs-human',
    blocking: [],
    improvements: [],
    discussions: [BALANCE_HINT],
    testGaps: [],
    escalationCategory: 'spend',
    summary: `No review ran: the IU provider balance is exhausted, fallback route included (${failed.map((r) => r.angle).join(', ')}). Review in-session with /code-review. Do NOT treat this as approval.`,
    degraded: 'provider_balance',
  }
}

/** Every reviewer failed: no review happened, and this must never read as approval. */
export function allFailedVerdict(failed: readonly FailedReviewer[], totalReviewers: number): ReviewResult {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    outcome: 'needs-human',
    blocking: [],
    improvements: [],
    discussions: failed.map((r) => ({
      file: PIPELINE,
      message: `${r.angle} session failed: ${r.failureReason}`,
      angle: r.angle,
    })),
    testGaps: [],
    escalationCategory: 'blocker',
    summary: `All ${totalReviewers} specialist reviewers failed — no review was actually performed. Causes: ${failed.map((r) => `${r.angle}: ${r.failureReason}`).join('; ')}. Do NOT treat this as approval.`,
  }
}

/**
 * The synthesis did not return valid JSON twice. The multi-angle run happened, so the raw synthesizer text is kept in a
 * discussion for manual triage instead of ending as a bare parse error. A reviewer that failed is still reported: its
 * pipeline discussion and the "Partial review" lead, over the true reviewer count.
 */
export function salvagedVerdict(raw: string, failed: readonly FailedReviewer[], totalReviewers: number): ReviewResult {
  const partial =
    failed.length > 0
      ? `Partial review: ${failed.length}/${totalReviewers} reviewers failed (${failed.map((r) => r.angle).join(', ')}). `
      : ''
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    outcome: 'needs-human',
    blocking: [],
    improvements: [],
    discussions: [
      ...failed.map((r) => ({
        file: PIPELINE,
        message: `${r.angle} session failed: ${r.failureReason} — this angle did not actually review the diff.`,
        angle: r.angle,
      })),
      {
        file: PIPELINE,
        message:
          'Synthesis did not return valid JSON after a retry, so the findings could not be structured. The multi-angle ' +
          'review DID run — its raw synthesizer output is preserved below for manual triage; re-run the review or read ' +
          `this directly:\n\n${raw.trim().slice(0, 6000) || '(no synthesizer text was captured)'}`,
        angle: 'synthesis',
      },
    ],
    testGaps: [],
    escalationCategory: 'blocker',
    summary: `${partial}Review ran ${totalReviewers} reviewers but synthesis failed to serialize a structured verdict (after one retry). Findings were NOT lost — see the discussions entries for the raw synthesizer text. Treat as needs-human.`,
  }
}
