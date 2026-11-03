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

/** Two seats agree when both answered `defect` with a place and the places overlap. */
function agree(first: Seat | undefined, second: Seat | undefined): boolean {
  const [x, y] = [claim(first), claim(second)]
  return x !== null && y !== null && locationsOverlap(x.location, y.location)
}

/**
 * Whether the record needs seat `c`: `a` and `b` both answered, at least one says defect, and they do not agree (the one
 * predicate of the acceptance rule: a disagreement, locations that do not overlap, or a defect without a location). A
 * record that has `c`, an error in `a` or `b`, or two `no` answers does not.
 */
export function needsThirdSeat(record: GtLabelRecord): boolean {
  const { a, b } = record
  if (record.c !== undefined || 'error' in a || 'error' in b) return false
  return (a.defect || b.defect) && !agree(a, b)
}

/**
 * The acceptance rule (2 of 3) over one candidate's labels: at least two seats say `defect` and the locations of two of
 * those overlap. The case takes the location, description, class and severity of seat `a` when it is in the agreeing
 * pair, else of the pair's first seat; `path` names the pair. Anything else is a rejection with its reason, which for
 * a record without `c` is the two-seat reason (`a-no`, `b-no`, `both-no`, `no-overlap`, `labeler-error`). `no-location`
 * is a rejection whose only problem is that fewer than two defect answers name a place.
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
    if (!agree(seats[first], seats[second])) continue
    const x = claim(seats[first]) as Defect
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
  // A defect without a place cannot form a pair: when fewer than two defect answers name one, that is the problem.
  const unplaced = [a, b, c].filter((seat) => claim(seat) !== null).length < 2
  if (c !== undefined && (a.defect || b.defect)) {
    if ('error' in c) return reject('c-error')
    if (!c.defect) return reject('c-no')
    return reject(unplaced ? 'no-location' : 'c-no-overlap')
  }
  if (!a.defect || !b.defect) return reject(a.defect ? 'b-no' : b.defect ? 'a-no' : 'both-no')
  return reject(unplaced ? 'no-location' : 'no-overlap')
}
