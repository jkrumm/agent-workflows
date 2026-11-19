import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryFixClassesOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
const FACTORY_FIX_CLASSES_SCORER_VERSION = '2026-11-16.1'

/**
 * A case's expected classes by sha. `basis` says how each label was settled: `files` (the changed paths decide it:
 * tests only, documentation only, scripts and CI only), `reading` (the commit's subject and body, read by one person)
 * or `written` (a commit made for the set).
 */
export const FactoryFixClassesReference = z.object({
  classes: z.record(z.string(), z.string().min(1)),
  basis: z.record(z.string(), z.enum(['files', 'reading', 'written'])),
})
export type FactoryFixClassesReference = z.output<typeof FactoryFixClassesReference>

const share = (flags: boolean[]) => flags.filter(Boolean).length / flags.length

/**
 * The `factory-fix-classes` scorer. Deterministic, no model. Every score is a share in [0, 1]:
 * - `valid`: the output parses and holds one answer for each sha of the case; when it is 0 (or the run failed) so is
 *   every other score;
 * - `accuracy`: commits sorted into the reference's class;
 * - `mechanical`: the same over the commits whose class the changed paths decide (`basis: files`); left out when the
 *   case has none;
 * - `judged`: the same over the commits whose class takes a reading (`reading`, `written`); left out when the case has none.
 * `pass`: every commit right.
 * A run without a reference (drift) scores `valid` only.
 */
export const factoryFixClassesScorer: Scorer<unknown, FactoryFixClassesReference> = {
  version: FACTORY_FIX_CLASSES_SCORER_VERSION,
  reference: FactoryFixClassesReference,
  score(_input, output, ctx): Verdict {
    const want = ctx.reference
    const parsed = FactoryFixClassesOutput.safeParse(output)
    if (!parsed.success) {
      return {
        scores: want ? { valid: 0, accuracy: 0 } : { valid: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not a fix-classes answer',
      }
    }
    if (!want) return { scores: { valid: 1 }, pass: true }
    const got = new Map(parsed.data.answers.map((a) => [a.sha, a.class]))
    const shas = Object.keys(want.classes)
    const known = shas.every((sha) => got.has(sha)) && got.size === shas.length
    if (!known)
      return { scores: { valid: 0, accuracy: 0 }, pass: false, feedback: 'the answers do not match the case’s shas' }

    const right = (sha: string) => got.get(sha) === want.classes[sha]
    const decidedBy = (kind: 'files' | 'judged') =>
      shas.filter((sha) => (want.basis[sha] === 'files') === (kind === 'files'))
    const scores: Record<string, number> = { valid: 1, accuracy: share(shas.map(right)) }
    const mechanical = decidedBy('files')
    const judged = decidedBy('judged')
    if (mechanical.length) scores.mechanical = share(mechanical.map(right))
    if (judged.length) scores.judged = share(judged.map(right))
    const wrong = shas.filter((sha) => !right(sha))
    return {
      scores,
      pass: wrong.length === 0,
      ...(wrong.length
        ? { feedback: wrong.map((sha) => `${sha.slice(0, 7)}: ${got.get(sha)} (want ${want.classes[sha]})`).join('; ') }
        : {}),
    }
  },
}
