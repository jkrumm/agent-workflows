import { RECOMMENDATIONS } from '@agent-workflows/capabilities'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { OVERVIEW_OUTPUT } from '../../fleet/schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const OVERVIEW_SCORER_VERSION = '2026-11-03.1'

const Recommendation = z.enum(RECOMMENDATIONS)

/**
 * The expected recommendation per agent id. A list accepts any of its values: an agent whose facts honestly allow two
 * readings (idle and clean, work done: `close` or `review`) is not scored down for either.
 */
export const OverviewReference = z.object({
  agents: z.record(z.string(), z.union([Recommendation, z.array(Recommendation).min(2)])),
})
export type OverviewReference = z.output<typeof OverviewReference>

const SCORE_KEYS = ['valid', 'answered', 'match'] as const
const ZERO = Object.fromEntries(SCORE_KEYS.map((k) => [k, 0]))

type Input = { fixture?: { projects: { agents: { id: string }[] }[] } } | null

/**
 * The `overview` scorer. Deterministic, no model. Every score is a share in 0..1; when `valid` is 0 so is every other:
 * - `valid`: the output parses, holds every agent of the input exactly once and no other (the fixture's agents; with no
 *   fixture, as a drift run, the reference's, else only that no id repeats);
 * - `answered`: agents the seat gave a verdict for, not the `synthesized` placeholder the host fills in for an omission;
 * - `match`: agents (of the reference) whose recommendation is the expected one, or one of the accepted ones.
 * `pass`: `valid` and, with a reference, every agent answered and matched: a fleet is a handful of agents, one miss is a
 * miss. Without a reference (drift) it is `valid` alone.
 */
export const overviewScorer: Scorer<Input, OverviewReference> = {
  version: OVERVIEW_SCORER_VERSION,
  reference: OverviewReference,
  score(input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = OVERVIEW_OUTPUT.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not an overview')
    const { agents } = parsed.data
    const ids = agents.map((a) => a.id)
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (repeated.length) return failed(`agents repeated: ${[...new Set(repeated)].join(', ')}`)

    const want = ctx.reference?.agents
    const fixtureIds = input?.fixture?.projects.flatMap((p) => p.agents.map((a) => a.id))
    const expected = fixtureIds ?? (want ? Object.keys(want) : null)
    if (expected) {
      const missing = expected.filter((id) => !ids.includes(id))
      const extra = ids.filter((id) => !expected.includes(id))
      if (missing.length || extra.length)
        return failed(
          [missing.length && `missing ${missing.join(', ')}`, extra.length && `unexpected ${extra.join(', ')}`]
            .filter(Boolean)
            .join('; '),
        )
    }

    const feedback: string[] = []
    const answeredFlags = agents.map((a) => {
      if (a.synthesized) feedback.push(`${a.id}: no verdict came back`)
      return !a.synthesized
    })
    const answered = agents.length === 0 ? 1 : answeredFlags.filter(Boolean).length / agents.length
    if (!want)
      return {
        scores: { valid: 1, answered },
        pass: true,
        ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
      }

    const byId = new Map(agents.map((a) => [a.id, a]))
    const hits = Object.entries(want).map(([id, accepted]) => {
      const got = byId.get(id)
      const ok = got !== undefined && (Array.isArray(accepted) ? accepted : [accepted]).includes(got.recommendation)
      if (!ok && got && !got.synthesized)
        feedback.push(`${id}: ${got.recommendation} (want ${Array.isArray(accepted) ? accepted.join('|') : accepted})`)
      return ok
    })
    const match = hits.length === 0 ? 1 : hits.filter(Boolean).length / hits.length
    return {
      scores: { valid: 1, answered, match },
      pass: answered === 1 && match === 1,
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}
