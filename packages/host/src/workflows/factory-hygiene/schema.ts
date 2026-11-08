import { isAbsolute } from 'node:path'
import { identifier } from '@agent-workflows/capabilities'
import { z } from 'zod'

// The wire of software-factory's hygiene loop (its `packages/contract/src/loops.ts`; the fixture key `hygiene` is the one
// example both repos parse). Keep the limits identical there.

export const MAX_CANDIDATES = 20
export const MAX_FINDINGS = 10
export const HYGIENE_KINDS = ['stale', 'slop'] as const

const oneLine = z.string().regex(/^[^\r\n\u2028\u2029]{1,240}$/, 'one line, at most 240 characters')

const candidate = z.object({
  path: z.string().min(1).max(300).describe('Relative to `cwd`; untrusted data'),
  why: oneLine.describe('One line: why the factory picked it; untrusted data'),
})

const hygieneInput = z.object({
  repo: identifier(200, '/').describe('The repo whose checkout this is'),
  cwd: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\r\n\u2028\u2029]+$/, 'one line')
    .refine(isAbsolute, 'cwd must be an absolute path')
    .describe('A read-only checkout of `ref`; the agent reads only below it'),
  ref: z.string().min(7).max(64).describe('The commit or ref the checkout is at'),
  stale: z
    .array(candidate)
    .max(MAX_CANDIDATES)
    .describe('Living documents whose code moved on since they were last edited'),
  slop: z.array(candidate).max(MAX_CANDIDATES).describe('Documents edited lately, to read for filler'),
  max: z.number().int().min(1).max(MAX_FINDINGS).describe('At most this many findings are returned'),
})
export type HygieneInput = z.output<typeof hygieneInput>

/** The workflow's input: one property because the CLI reads exactly one property from stdin. */
export const FactoryHygieneInput = z.object({
  hygiene: hygieneInput.describe(
    "A repo's hygiene candidates over a read-only checkout, piped on stdin as JSON: `{repo, cwd, ref, stale[], slop[], max}`",
  ),
})

const finding = z.object({
  kind: z.enum(HYGIENE_KINDS),
  path: z.string().min(1).max(300).describe('A candidate of the same kind, copied exactly'),
  title: oneLine.describe('A stable one-liner: no counts, dates or line numbers (the factory fingerprints it)'),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('stale: the claim and the code that contradicts it, both as path:line. slop: the quoted lines'),
  fix: z.string().trim().min(1).max(4000).describe('The concrete edit'),
})

/** The answer: findings over the candidates; `[]` is the common answer. */
export const FactoryHygieneOutput = z.object({
  findings: z.array(finding).max(MAX_FINDINGS).describe('Verified defects; [] is the common answer'),
  read: z
    .number()
    .int()
    .min(0)
    .max(2 * MAX_CANDIDATES)
    .describe('How many candidates were actually read'),
  reason: oneLine.describe('One line: the deciding fact'),
})
export type FactoryHygieneOutputValue = z.output<typeof FactoryHygieneOutput>

export const hygieneNone = (reason: string): FactoryHygieneOutputValue => ({
  findings: [],
  read: 0,
  reason: reason.slice(0, 240).replace(/[\r\n\u2028\u2029]+/g, ' ') || 'unavailable',
})
