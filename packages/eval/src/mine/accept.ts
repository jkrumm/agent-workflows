import type { z } from 'zod'
import {
  type GtBugCase,
  type GtCandidate,
  type GtLabelRecord,
  type GtLocation,
  type GtRejected,
  LOCATION_SLACK,
  type RejectReason,
} from '../gt.ts'
import { splitOf } from './split.ts'

type GtRejected = z.infer<typeof GtRejected>
type RejectReason = z.infer<typeof RejectReason>

export type Acceptance = { accepted: true; case: GtBugCase } | { accepted: false; rejected: GtRejected }

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

/**
 * The acceptance rule over one candidate's two labels: both seats say `defect` and their locations overlap. The case
 * takes seat `a`'s location, description, class and severity. Anything else is a rejection with its reason.
 */
export function acceptRecord(record: GtLabelRecord, candidate: GtCandidate): Acceptance {
  const reject = (reason: RejectReason): Acceptance => ({
    accepted: false,
    rejected: { candidateId: record.candidateId, reason, labelerVersion: record.labelerVersion },
  })
  const { a, b } = record
  if ('error' in a || 'error' in b) return reject('labeler-error')
  if (!a.defect || !b.defect) return reject(a.defect ? 'b-no' : b.defect ? 'a-no' : 'both-no')
  if (!a.location || !b.location || !locationsOverlap(a.location, b.location)) return reject('no-overlap')
  return {
    accepted: true,
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
        location: a.location,
        description: a.description,
        bugClass: a.bugClass,
        severity: a.severity,
        fixSha: candidate.fixSha,
        fixSubject: candidate.fixSubject,
      },
    },
  }
}
