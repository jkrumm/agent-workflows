import type { z } from 'zod'
import {
  type AcceptPath,
  type GtBugCase,
  type GtCandidate,
  type GtLabelRecord,
  type GtLocation,
  type GtRejected as GtRejectedSchema,
  LOCATION_SLACK,
  type RejectReason as RejectReasonSchema,
} from '../gt.ts'
import { splitOf } from './split.ts'

type Rejected = z.infer<typeof GtRejectedSchema>
type Reason = z.infer<typeof RejectReasonSchema>

export type Acceptance = { accepted: true; case: GtBugCase; path: AcceptPath } | { accepted: false; rejected: Rejected }

const normalPath = (path: string) =>
  path
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')

/** Same file (normalised) and the line ranges, each widened by `LOCATION_SLACK`, touch. */
export function locationsOverlap(a: GtLocation, b: GtLocation): boolean {
  return (
    normalPath(a.file) === normalPath(b.file) &&
    a.startLine <= b.endLine + LOCATION_SLACK &&
    b.startLine <= a.endLine + LOCATION_SLACK
  )
}

type Seat = GtLabelRecord['a']
type Defect = Extract<Seat, { defect: boolean }> & { location: GtLocation }

/** A seat that answered `defect` with a place. */
const claim = (seat: Seat | undefined): Defect | null =>
  seat && 'defect' in seat && seat.defect && seat.location ? (seat as Defect) : null

/** The pairs in the order they are tried: the case comes from the first pair that agrees, and `a` leads. */
const PAIRS = [
  ['a', 'b', 'a+b'],
  ['a', 'c', 'a+c'],
  ['b', 'c', 'b+c'],
] as const

/**
 * Whether the record needs seat `c`: `a` and `b` both answered and disagree, one saying defect and the other not, or
 * both saying defect with locations that do not overlap. A record that has `c` (or an error in `a` or `b`) does not.
 */
export function needsThirdSeat(record: GtLabelRecord): boolean {
  const { a, b } = record
  if (record.c !== undefined || 'error' in a || 'error' in b) return false
  if (a.defect !== b.defect) return true
  const [x, y] = [claim(a), claim(b)]
  return !x || !y ? false : !locationsOverlap(x.location, y.location)
}

/**
 * The acceptance rule (2 of 3) over one candidate's labels: at least two seats say `defect` and the locations of two of
 * those overlap. The case takes the location, description, class and severity of seat `a` when it is in the agreeing
 * pair, else of the pair's first seat; `path` names the pair. Anything else is a rejection with its reason, which for
 * a record without `c` is the two-seat reason (`a-no`, `b-no`, `both-no`, `no-overlap`, `labeler-error`).
 */
export function acceptRecord(record: GtLabelRecord, candidate: GtCandidate): Acceptance {
  const reject = (reason: Reason): Acceptance => ({
    accepted: false,
    rejected: { candidateId: record.candidateId, reason, labelerVersion: record.labelerVersion },
  })
  const { a, b, c } = record
  if ('error' in a || 'error' in b) return reject('labeler-error')
  const seats = { a, b, c }
  for (const [first, second, path] of PAIRS) {
    const x = claim(seats[first])
    const y = claim(seats[second])
    if (!x || !y || !locationsOverlap(x.location, y.location)) continue
    return {
      accepted: true,
      path,
      case: {
        kind: 'bug',
        id: candidate.id,
        candidateId: candidate.id,
        split: splitOf(candidate.id),
        repo: candidate.repo,
        sha: candidate.introSha,
        parent: candidate.introParent,
        subject: candidate.introSubject,
        minerVersion: candidate.minerVersion,
        bug: {
          location: x.location,
          description: x.description,
          bugClass: x.bugClass,
          severity: x.severity,
          fixSha: candidate.fixSha,
          fixSubject: candidate.fixSubject,
        },
      },
    }
  }
  if (c !== undefined && (a.defect || b.defect)) {
    if ('error' in c) return reject('c-error')
    return reject(c.defect ? 'c-no-overlap' : 'c-no')
  }
  if (!a.defect || !b.defect) return reject(a.defect ? 'b-no' : b.defect ? 'a-no' : 'both-no')
  return reject('no-overlap')
}
