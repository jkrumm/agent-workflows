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
  needsThirdSeat,
} from '@agent-workflows/eval'
// The capability owns the version of its prompt, models and schema.
import { LABELER_C_VERSION, LABELER_VERSION } from '@agent-workflows/capabilities'

export { LABELER_C_VERSION, LABELER_VERSION }

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

/** A record, plus the reason labelling must stop when a seat failed for a reason that is not about the candidate. */
export type Labelled = { record: GtLabelRecord; stop?: string } | { stop: string }

type Options = {
  candidate: GtCandidate
  home: string
  exec: Exec
  registry: LabelCaller
  callContext: CallOptions
  runId: string
  now: () => Date
}

type Context = { context: Omit<LabelInput, 'seat'> } | { stop: string } | { gone: string }

/**
 * What every seat is shown. A commit that is gone from the checkout is about the candidate (it is the same on every
 * retry): `gone`. Any other git failure (a lock, a timeout, a missing checkout) is the host's: `stop`.
 */
async function contextOf(options: Options): Promise<Context> {
  const { candidate } = options
  const git = gitIn(options.exec, join(options.home, candidate.repo))
  try {
    const [introDiff, introBody, fixDiff, fixBody] = await Promise.all([
      git(['show', '--format=', candidate.introSha]),
      git(['show', '-s', '--format=%b', candidate.introSha]),
      git(['show', '--format=', candidate.fixSha]),
      git(['show', '-s', '--format=%b', candidate.fixSha]),
    ])
    return {
      context: {
        candidateId: candidate.id,
        introSubject: candidate.introSubject,
        introBody: introBody.trim(),
        introDiff,
        fixSubject: candidate.fixSubject,
        fixBody: fixBody.trim(),
        fixDiff,
        blamed: candidate.blamed,
      },
    }
  } catch (error) {
    return MISSING_OBJECT.test(errorText(error))
      ? { gone: `git: ${errorText(error)}`.slice(0, 500) }
      : { stop: errorText(error) }
  }
}

type Answer = { seat: GtLabelRecord['a'] } | { stop: string }

/** One seat on the shared context: its answer, or the failure that is not about the candidate. */
async function ask(options: Options, context: Omit<LabelInput, 'seat'>, seat: LabelerSeat): Promise<Answer> {
  try {
    return {
      seat: await options.registry.call('eval.label', LabelInput.parse({ ...context, seat }), options.callContext),
    }
  } catch (error) {
    const answer = seatAnswer(error)
    return answer === null ? { stop: errorText(error) } : { seat: { error: answer } }
  }
}

/**
 * Seats `a` and `b` on one candidate, in parallel, then `c` when they disagree (`needsThirdSeat`). A record when `a`
 * and `b` each answered (an answer failure is recorded as that seat's `{error}`); a stop when one failed for a reason
 * that is not about the candidate, in which case nothing is recorded and the candidate stays unlabelled. A stop of
 * seat `c` alone keeps the record of `a` and `b` (they are paid for) and leaves `c` for the next run.
 */
export async function labelCandidate(options: Options): Promise<Labelled> {
  const { candidate } = options
  const record = (a: GtLabelRecord['a'], b: GtLabelRecord['b']): GtLabelRecord => ({
    candidateId: candidate.id,
    labelerVersion: LABELER_VERSION,
    at: options.now().toISOString(),
    a,
    b,
    runId: options.runId,
  })
  const read = await contextOf(options)
  if ('stop' in read) return read
  if ('gone' in read) return { record: record({ error: read.gone }, { error: read.gone }) }
  const [a, b] = await Promise.all([ask(options, read.context, 'a'), ask(options, read.context, 'b')])
  const stopped = [a, b].find((answer) => 'stop' in answer)
  if (stopped && 'stop' in stopped) return stopped
  const labelled = record((a as { seat: GtLabelRecord['a'] }).seat, (b as { seat: GtLabelRecord['b'] }).seat)
  return needsThirdSeat(labelled) ? withThirdSeat(options, labelled, read.context) : { record: labelled }
}

/**
 * Seat `c` on a record that lacks it (or whose `c` was an error, with `relabelErrors`): the record with `c`, its version
 * and the run that paid, or a stop. Never touches `a` and `b`.
 */
export async function labelThirdSeat(options: Options & { record: GtLabelRecord }): Promise<Labelled> {
  const read = await contextOf(options)
  if ('stop' in read) return read
  const { record } = options
  if ('gone' in read) return { record: third(options, record, { error: read.gone }) }
  return withThirdSeat(options, record, read.context)
}

const third = (options: Options, record: GtLabelRecord, c: GtLabelRecord['a']): GtLabelRecord => ({
  ...record,
  c,
  cVersion: LABELER_C_VERSION,
  cRunId: options.runId,
})

async function withThirdSeat(
  options: Options,
  record: GtLabelRecord,
  context: Omit<LabelInput, 'seat'>,
): Promise<Labelled> {
  const c = await ask(options, context, 'c')
  return 'stop' in c ? { record, stop: c.stop } : { record: third(options, record, c.seat) }
}
