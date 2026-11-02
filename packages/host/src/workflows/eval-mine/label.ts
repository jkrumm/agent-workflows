import { join } from 'node:path'
import type { CallOptions } from '@agent-workflows/capabilities'
import {
  type Exec,
  type GtCandidate,
  type GtLabelRecord,
  gitIn,
  LabelInput,
  type LabelOutput,
  type LabelerSeat,
} from '@agent-workflows/eval'

/**
 * The labeller version: bump when the labeller's prompt or model changes (the capability's, `eval.label`), so every
 * candidate is labelled again under it. A record under another version is ignored, never deleted.
 */
export const LABELER_VERSION = '2026-11-02.1'

/** The one capability the miner calls, once per seat; any registry that serves `eval.label` fits. */
export interface LabelCaller {
  call(id: 'eval.label', input: LabelInput, options: CallOptions): Promise<LabelOutput>
}

/** Codes of a failure that is the seat's answer about this candidate (it was asked and could not answer usably). */
const SEAT_ANSWER_CODES = new Set(['INVALID_OUTPUT', 'OUTPUT_TRUNCATED', 'INVALID_INPUT'])

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The text recorded for a seat that failed with an answer: an unusable or truncated output, an input it refused, or a
 * vendor's own refusal (a moderation block). Null for anything else: the gateway's 403 "no eval credit", an outage, a
 * missing configuration or a cancel are not about the candidate, and labelling stops on them.
 */
export function seatAnswer(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const { code, data } = error as { code?: unknown; data?: { userError?: unknown } }
  const answered =
    (typeof code === 'string' && SEAT_ANSWER_CODES.has(code)) ||
    (code === 'UPSTREAM_ERROR' && data?.userError !== undefined)
  return answered ? `${String(code)}: ${error.message}`.slice(0, 500) : null
}

/** git's words for a commit that is not in the repository (rewritten history, a pruned object). */
const MISSING_OBJECT = /bad object|bad revision|unknown revision|not a valid object name|invalid object name/i

export type Labelled = { record: GtLabelRecord } | { stop: string }

/**
 * Both seats on one candidate, in parallel. A record when each seat answered (an answer failure is recorded as that
 * seat's `{error}`); a stop when a seat failed for a reason that is not about the candidate, in which case nothing is
 * recorded and the candidate stays unlabelled.
 */
export async function labelCandidate(options: {
  candidate: GtCandidate
  home: string
  exec: Exec
  registry: LabelCaller
  callContext: CallOptions
  runId: string
  now: () => Date
}): Promise<Labelled> {
  const { candidate, registry, callContext } = options
  const record = (a: GtLabelRecord['a'], b: GtLabelRecord['b']): Labelled => ({
    record: {
      candidateId: candidate.id,
      labelerVersion: LABELER_VERSION,
      at: options.now().toISOString(),
      a,
      b,
      runId: options.runId,
    },
  })
  const git = gitIn(options.exec, join(options.home, candidate.repo))
  let context: Omit<LabelInput, 'seat'>
  try {
    const [introDiff, introBody, fixDiff, fixBody] = await Promise.all([
      git(['show', '--format=', candidate.introSha]),
      git(['show', '-s', '--format=%b', candidate.introSha]),
      git(['show', '--format=', candidate.fixSha]),
      git(['show', '-s', '--format=%b', candidate.fixSha]),
    ])
    context = {
      candidateId: candidate.id,
      introSubject: candidate.introSubject,
      introBody: introBody.trim(),
      introDiff,
      fixSubject: candidate.fixSubject,
      fixBody: fixBody.trim(),
      fixDiff,
      blamed: candidate.blamed,
    }
  } catch (error) {
    // Only a commit that is gone from the checkout is about the candidate: it is the same on every retry, so both
    // seats are recorded as failed. Any other git failure (a lock, a timeout, a missing checkout) is the host's: stop.
    if (!MISSING_OBJECT.test(errorText(error))) return { stop: errorText(error) }
    const failed = { error: `git: ${errorText(error)}`.slice(0, 500) }
    return record(failed, failed)
  }
  const ask = (seat: LabelerSeat) => registry.call('eval.label', LabelInput.parse({ ...context, seat }), callContext)
  const [a, b] = await Promise.allSettled([ask('a'), ask('b')])
  const seats: GtLabelRecord['a'][] = []
  for (const outcome of [a, b]) {
    if (outcome.status === 'fulfilled') {
      seats.push(outcome.value)
      continue
    }
    const answer = seatAnswer(outcome.reason)
    if (answer === null) return { stop: errorText(outcome.reason) }
    seats.push({ error: answer })
  }
  return record(seats[0] as GtLabelRecord['a'], seats[1] as GtLabelRecord['b'])
}
