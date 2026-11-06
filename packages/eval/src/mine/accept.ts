import type { z } from 'zod'
import {
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

export type Acceptance = { accepted: true; case: GtBugCase; path: 'a+b' } | { accepted: false; rejected: Rejected }

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

/** Two seats agree when both answered `defect` with a place and the places overlap. */
function agree(first: Seat | undefined, second: Seat | undefined): boolean {
  const [x, y] = [claim(first), claim(second)]
  return x !== null && y !== null && locationsOverlap(x.location, y.location)
}

/**
 * The acceptance rule over one candidate's labels: seats `a` and `b` both say `defect` and their locations overlap. The
 * case takes the location, description, class and severity of seat `a`; `path` is `a+b`. Anything else is a rejection
 * with its two-seat reason (`a-no`, `b-no`, `both-no`, `no-overlap`, `no-location`, `labeler-error`). A legacy `c` on
 * the record is ignored.
 */
export function acceptRecord(record: GtLabelRecord, candidate: GtCandidate): Acceptance {
  const reject = (reason: Reason): Acceptance => ({
    accepted: false,
    rejected: { candidateId: record.candidateId, reason, labelerVersion: record.labelerVersion },
  })
  const { a, b } = record
  if ('error' in a || 'error' in b) return reject('labeler-error')
  if (!a.defect || !b.defect) return reject(a.defect ? 'b-no' : b.defect ? 'a-no' : 'both-no')
  const x = claim(a)
  if (x === null || claim(b) === null) return reject('no-location')
  if (!agree(a, b)) return reject('no-overlap')
  return {
    accepted: true,
    path: 'a+b',
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
