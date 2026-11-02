import { z } from 'zod'
import { JudgeClass, RejectReason } from '../gt.ts'

/**
 * The truth behind each item of an owner session, kept beside the page and never inside it: the page is blind. A case
 * item is a candidate id (`GtCandidate.id`); a pair item is `<caseId>:<judge run id>:<finding id>`.
 */
export const ManifestItem = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('case'),
      id: z.string().min(1),
      truth: z.enum(['accepted', 'rejected']),
      /** Why a rejected candidate was dropped. */
      reason: RejectReason.optional(),
      /** Whose claim the page shows: a labeller's seat, or none (the page then names the lines the fix changed). */
      claimedBy: z.enum(['a', 'b', 'none']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pair'),
      id: z.string().min(1),
      caseId: z.string(),
      judgeRunId: z.string(),
      findingId: z.string(),
      judgeClass: JudgeClass,
    })
    .strict(),
])
export type ManifestItem = z.infer<typeof ManifestItem>

export const PackManifest = z
  .object({
    sessionId: z.string().min(1),
    createdAt: z.iso.datetime(),
    seed: z.number().int(),
    evalRuns: z.array(z.string()),
    /** Shortfalls and skips the pack ran into, as the page and the workflow output say them. */
    notes: z.array(z.string()),
    items: z.array(ManifestItem),
  })
  .strict()
export type PackManifest = z.infer<typeof PackManifest>
