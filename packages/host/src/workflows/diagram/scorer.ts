import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { measureDocument } from './metrics.ts'
import type { DiagramInputValue } from './schema.ts'
import { DiagramOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const DIAGRAM_SCORER_VERSION = '2026-10-29.1'

/** A case's expectation: the element count the brief asks for. Both bounds are optional; no reference scores nothing here. */
export const DiagramReference = z
  .object({ minElements: z.number().int().positive().optional(), maxElements: z.number().int().positive().optional() })
  .nullable()
export type DiagramReference = z.output<typeof DiagramReference>

/**
 * The `diagram` scorer (concept §6; the rule is `docs/research/2026-10-29-wave7-ports.md` §diagram). Deterministic, no
 * model, counted from the hydrated document:
 * - `valid`: 1 when the output holds a v2 `.excalidraw` document (type, version, elements, appState); else 0 and the
 *   only score, so a failed run counts in the valid rate and leaves the other means alone (they are over valid runs);
 * - `elementCount`: live elements (informational: neither more nor fewer is better);
 * - `boundArrowShare` in [0, 1]: arrows with both ends bound to existing elements; left out when there is no arrow;
 * - `overlaps`: pairs of shapes whose boxes cross without one holding the other, lower is better;
 * - `textOverflow`: labels wider than their container, lower is better;
 * - `inRange` (with a reference that sets bounds): the element count is within them.
 * `pass`: valid, every arrow bound, no label overflow, and in range when asked.
 */
export const diagramScorer: Scorer<DiagramInputValue, DiagramReference> = {
  version: DIAGRAM_SCORER_VERSION,
  reference: DiagramReference,
  score(_input, output, ctx): Verdict {
    const parsed = DiagramOutput.safeParse(output)
    const metrics = parsed.success ? measureDocument(parsed.data.document) : null
    if (!metrics?.valid) {
      return {
        scores: { valid: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output holds no v2 .excalidraw document',
      }
    }
    const scores: Record<string, number> = {
      valid: 1,
      elementCount: metrics.elementCount,
      overlaps: metrics.overlaps,
      textOverflow: metrics.textOverflow,
    }
    if (metrics.boundArrowShare !== null) scores.boundArrowShare = metrics.boundArrowShare
    const problems: string[] = []
    if (metrics.boundArrowShare !== null && metrics.boundArrowShare < 1)
      problems.push('an arrow is not bound at both ends')
    if (metrics.textOverflow > 0) problems.push(`${metrics.textOverflow} label(s) wider than their container`)
    const { minElements, maxElements } = ctx.reference ?? {}
    if (minElements !== undefined || maxElements !== undefined) {
      const inRange =
        metrics.elementCount >= (minElements ?? 0) && metrics.elementCount <= (maxElements ?? Number.POSITIVE_INFINITY)
      scores.inRange = inRange ? 1 : 0
      if (!inRange)
        problems.push(`${metrics.elementCount} elements, expected ${minElements ?? 0}-${maxElements ?? 'any'}`)
    }
    return { scores, pass: problems.length === 0, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}
