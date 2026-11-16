import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryQueueOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_QUEUE_SCORER_VERSION = '2026-11-16.1'

/**
 * A case's expected edges: the pairs of Issues that must not run side by side, in either direction (`[a, b]` is met by an
 * edge `a after b` or `b after a`: the factory orders a pair either way). An empty `pairs` is a quiet queue: no edge is the
 * right answer. `basis` says what showed it (`issue-outcome`, `quiet`, `written`); people read it, the scorer does not.
 */
export const FactoryQueueReference = z.object({
  pairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
  basis: z.string().min(1),
})
export type FactoryQueueReference = z.output<typeof FactoryQueueReference>

/**
 * The `factory-queue` scorer. Deterministic, no model. Every score is a share in [0, 1]:
 * - `valid`: the output parses as an answer; when it is 0 (or the run failed) the other scores are 0;
 * - `edgeRecall`: of the reference's pairs, the share the answer proposes an edge for (either direction); left out on a
 *   quiet case;
 * - `quiet`: 1 when the answer proposes no edge; left out on a case that has pairs (an extra edge there is not proven
 *   wrong, only unproven).
 * The order is not scored: the factory's own order and the guard (blockers first, the owner's priority untouched) leave no
 * independent truth to measure a tie-break against; a later start order is the factory's own doing.
 * `pass`: `edgeRecall` and `quiet`, where they exist, are 1. A run without a reference (drift) scores `valid` only.
 */
export const factoryQueueScorer: Scorer<unknown, FactoryQueueReference> = {
  version: FACTORY_QUEUE_SCORER_VERSION,
  reference: FactoryQueueReference,
  score(_input, output, ctx): Verdict {
    const want = ctx.reference
    const parsed = FactoryQueueOutput.safeParse(output)
    if (!parsed.success) {
      const gate = want && want.pairs.length === 0 ? 'quiet' : 'edgeRecall'
      return {
        scores: want ? { valid: 0, [gate]: 0 } : { valid: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not a queue answer',
      }
    }
    if (!want) return { scores: { valid: 1 }, pass: true }
    const { edges } = parsed.data
    if (want.pairs.length === 0) {
      const quiet = edges.length === 0 ? 1 : 0
      return {
        scores: { valid: 1, quiet },
        pass: quiet === 1,
        ...(quiet === 1
          ? {}
          : { feedback: `edges on a quiet queue: ${edges.map((e) => `${e.issue} after ${e.after}`).join('; ')}` }),
      }
    }
    const found = want.pairs.filter(([a, b]) =>
      edges.some((e) => (e.issue === a && e.after === b) || (e.issue === b && e.after === a)),
    )
    const edgeRecall = found.length / want.pairs.length
    const missed = want.pairs.filter((pair) => !found.includes(pair))
    return {
      scores: { valid: 1, edgeRecall },
      pass: edgeRecall === 1,
      ...(missed.length ? { feedback: `no edge for ${missed.map(([a, b]) => `${a}/${b}`).join(', ')}` } : {}),
    }
  },
}
