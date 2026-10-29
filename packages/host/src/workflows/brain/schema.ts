import { z } from 'zod'

export const BrainInput = z
  .object({
    question: z.string().min(3).max(4_000).describe('The question to answer from the vault'),
  })
  .strict()
export type BrainInputValue = z.output<typeof BrainInput>

export const BrainCitation = z.object({
  path: z.string().describe('Vault-relative path of a note this run read'),
  claim: z.string().describe("What that note says, in the answer's words"),
})

/** What the agent submits; status, warnings and grounding are derived in code. */
export const Draft = z.object({
  found: z.boolean().default(true),
  answer: z.string().min(1),
  citations: z.array(z.object({ path: z.string(), claim: z.string() })).default([]),
})
export type Draft = z.output<typeof Draft>

/**
 * Counted in code, never asserted by a model: `citations` is every citation the agent submitted before the grounding
 * rule (which drops the ones whose note the run did not read), `grounded` how many of them cite a note it read.
 */
export const BrainGrounding = z.object({
  citations: z.number().int().nonnegative(),
  grounded: z.number().int().nonnegative(),
})

/**
 * The brain workflow's output, a stable contract other workflows (research, podcast) call it through as a child:
 * - `answer`: markdown, from the notes read only; "Not in the vault." when they do not answer.
 * - `citations`: the notes the answer rests on, each one read in this run.
 * - `read`: every note the run read, vault-relative, in reading order.
 * - `status`: `ok` (answered, every citation grounded), `partial` (answered, but a citation was dropped, none was
 *   grounded, or nothing was read), `notfound` (the vault does not answer).
 * - `warnings`: what the grounding rule did.
 */
export const BrainOutput = z.object({
  answer: z.string(),
  citations: z.array(BrainCitation),
  read: z.array(z.string()),
  status: z.enum(['ok', 'partial', 'notfound']),
  warnings: z.array(z.string()),
  grounding: BrainGrounding,
})
export type BrainResult = z.output<typeof BrainOutput>
