import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { CLASSES, EFFORTS, FactoryClassifyOutput, KINDS, SIZES, TIERS } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_CLASSIFY_SCORER_VERSION = '2026-11-02.1'

/** A case's expected verdict: what a careful owner would have answered for the Issue. */
export const FactoryClassifyReference = z.object({
  project: z.string().nullable(),
  kind: z.enum(KINDS),
  class: z.enum(CLASSES),
  size: z.enum(SIZES),
  tier: z.enum(TIERS),
  effort: z.enum(EFFORTS),
})
export type FactoryClassifyReference = z.output<typeof FactoryClassifyReference>

const ZERO = {
  valid: 0,
  project: 0,
  kind: 0,
  class: 0,
  size: 0,
  tier: 0,
  effort: 0,
  classSafe: 0,
  tierSafe: 0,
}

const rank = <T extends string>(order: readonly T[], value: T) => order.indexOf(value)

/**
 * The `factory-classify` scorer (concept §6). Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the verdict and its `project` is one of the Issue's projects (or null); when it is 0 so is every other score;
 * - per field `project`, `kind`, `class`, `size`, `tier`, `effort`: exact agreement with the reference;
 * - `classSafe`: the answered class is at least as restrictive as the reference (routine < risky < business). A `business`
 *   Issue answered `routine` is the one mistake that sends the owner's decision to a worker;
 * - `tierSafe`: the answered tier is at least the reference's. An under-tiered lead fails and is retried a tier up; an
 *   over-tiered one only costs.
 * `pass`: valid, and `project`, `kind` and `class` exact, and `tierSafe`. Size and effort are reported, not gated: their
 * edges (s against m) are judgment calls the tier already prices.
 */
export const factoryClassifyScorer: Scorer<unknown, FactoryClassifyReference> = {
  version: FACTORY_CLASSIFY_SCORER_VERSION,
  reference: FactoryClassifyReference,
  score(input, output, ctx): Verdict {
    const parsed = FactoryClassifyOutput.safeParse(output)
    const projects = (input as { issue?: { projects?: string[] } } | null)?.issue?.projects ?? []
    // An invalid answer scores 0 on every safety score too: the means over the cases must not skip a failure.
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a classification')
    const got = parsed.data
    if (got.project !== null && !projects.includes(got.project))
      return failed(`project "${got.project}" is not one of the Issue's projects`)
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const exact = (field: keyof FactoryClassifyReference) => (got[field] === want[field] ? 1 : 0)
    const scores = {
      valid: 1,
      project: exact('project'),
      kind: exact('kind'),
      class: exact('class'),
      size: exact('size'),
      tier: exact('tier'),
      effort: exact('effort'),
      classSafe: rank(CLASSES, got.class) >= rank(CLASSES, want.class) ? 1 : 0,
      tierSafe: rank(TIERS, got.tier) >= rank(TIERS, want.tier) ? 1 : 0,
    }
    const wrong = (['project', 'kind', 'class'] as const).filter((f) => scores[f] === 0)
    const problems = [
      ...wrong.map((f) => `${f}: ${String(got[f])} (want ${String(want[f])})`),
      ...(scores.tierSafe === 0 ? [`tier: ${got.tier} is below ${want.tier}`] : []),
    ]
    return { scores, pass: problems.length === 0, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}
