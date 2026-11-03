import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { lintProse } from '../prose/lint.ts'
import { lower, mentions } from '../scorer-text.ts'
import type { ProsePolishInputValue } from './schema.ts'
import { ProsePolishOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const PROSE_POLISH_SCORER_VERSION = '2026-11-03.1'

/**
 * What a careful editor expects of one draft:
 * - `gone`: the phrases planted in the draft (lexicon the lint bans, a parallelism); none may be left in the text, matched
 *   as a case-insensitive substring so a stem (`leverag`) covers its forms;
 * - `keep`: the facts that must survive (numbers, names, a command); each is a whole token of the text, `a|b` accepts either;
 * - `chars`: the band of the text's length as a share of the draft's, default 0.5 to 1.25.
 */
export const ProsePolishReference = z.object({
  gone: z.array(z.string().min(1)).default([]),
  keep: z.array(z.string().min(1)).default([]),
  chars: z.tuple([z.number().positive(), z.number().positive()]).optional(),
})
export type ProsePolishReference = z.output<typeof ProsePolishReference>

const DEFAULT_BAND: [number, number] = [0.5, 1.25]
const SCORE_KEYS = ['valid', 'honest', 'notWorse', 'fixed', 'gone', 'facts', 'length'] as const
const ZERO = Object.fromEntries(SCORE_KEYS.map((k) => [k, 0]))

/**
 * The `prose-polish` scorer. Deterministic, no model: the lint is code, so it is run again here on the original and on
 * the text that came back. Every score is in 0..1; when `valid` is 0 so is every other score:
 * - `valid`: the output parses as a polish result;
 * - `honest`: the result tells the truth about itself. `lint.before` and `lint.after` are the findings of the draft and of
 *   the text, `lint.findings` holds `after` of them, and `kept: original` returns the draft unchanged;
 * - `notWorse`: the text has no more findings than the draft;
 * - `fixed`: the text has fewer findings than the draft (1 for a draft with none);
 * - `gone`: the share of the planted phrases no longer in the text;
 * - `facts`: the share of `keep` facts still in the text;
 * - `length`: the text's length, as a share of the draft's, is inside the band.
 * `pass`: every score is 1. A writer the keep gate refused (`kept: original`) fails `fixed` and `gone` on a draft with
 * issues, which is the point: the original is a safe answer, not a good one. Without a reference (drift) it checks
 * `valid`, `honest` and `notWorse` only.
 */
export const prosePolishScorer: Scorer<ProsePolishInputValue, ProsePolishReference> = {
  version: PROSE_POLISH_SCORER_VERSION,
  reference: ProsePolishReference,
  score(input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = ProsePolishOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a polish result')
    const out = parsed.data
    const feedback: string[] = []

    const before = lintProse(input.text, out.language).length
    const after = lintProse(out.text, out.language).length
    const honest =
      out.lint.before === before &&
      out.lint.after === after &&
      out.lint.findings.length === out.lint.after &&
      (out.kept === 'rewrite' || out.text === input.text)
    if (!honest)
      feedback.push(
        `lint before/after ${out.lint.before}/${out.lint.after} (recomputed ${before}/${after}) or the kept text is not as reported`,
      )
    const notWorse = after <= before
    if (!notWorse) feedback.push(`lint findings rose from ${before} to ${after}`)

    const base = { valid: 1, honest: honest ? 1 : 0, notWorse: notWorse ? 1 : 0 }
    const want = ctx.reference
    const done = (scores: Record<string, number>, pass: boolean): Verdict => ({
      scores,
      pass,
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    })
    if (!want) return done(base, honest && notWorse)

    const fixed = before === 0 || after < before
    if (!fixed) feedback.push(`lint findings are ${after} (draft ${before})`)
    const left = want.gone.filter((g) => lower(out.text).includes(lower(g)))
    if (left.length) feedback.push(`still in the text: ${left.join(', ')}`)
    const lost = want.keep.filter((k) => !mentions(out.text, k))
    if (lost.length) feedback.push(`lost: ${lost.join(', ')}`)
    const [min, max] = want.chars ?? DEFAULT_BAND
    const ratio = out.text.length / input.text.length
    const inBand = ratio >= min && ratio <= max
    if (!inBand) feedback.push(`text is ${ratio.toFixed(2)} of the draft's length (band ${min}-${max})`)

    const scores = {
      ...base,
      fixed: fixed ? 1 : 0,
      gone: want.gone.length === 0 ? 1 : (want.gone.length - left.length) / want.gone.length,
      facts: want.keep.length === 0 ? 1 : (want.keep.length - lost.length) / want.keep.length,
      length: inBand ? 1 : 0,
    }
    return done(
      scores,
      SCORE_KEYS.every((k) => scores[k] === 1),
    )
  },
}
