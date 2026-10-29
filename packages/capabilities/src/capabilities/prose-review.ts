import type { ResolvedRoute } from '@agent-workflows/routes'
import { fallbackRoute } from '@agent-workflows/routes'
import { z } from 'zod'
import { completeJson, type LlmDeps, resolve } from '../llm/model-call.ts'
import { CapabilityError } from '../errors.ts'
import { defineCapability } from '../procedure.ts'

/** The most prompt the seat reads: the draft is at most 60k characters, the rest is instructions and fenced context. */
export const MAX_PROSE_PROMPT_CHARS = 100_000

export const PROSE_CRITERIA = [
  'verdict_first',
  'structure',
  'no_repetition',
  'concision',
  'precision',
  'clarity',
  'visual_fit',
  'naturalness',
  'engagement',
] as const
/** Notes may also carry `invented_content`, a finding with no score of its own. */
const NOTE_CRITERIA = [...PROSE_CRITERIA, 'invented_content'] as const

const SCORE = z.number().int().min(1).max(5)

const REVIEW = z.object({
  scores: z.object({
    verdict_first: SCORE.optional(),
    structure: SCORE,
    no_repetition: SCORE,
    concision: SCORE,
    precision: SCORE,
    clarity: SCORE,
    visual_fit: SCORE,
    naturalness: SCORE,
    engagement: SCORE,
  }),
  notes: z.array(z.object({ criterion: z.enum(NOTE_CRITERIA), note: z.string().min(1).max(400) })).max(30),
  visualSuggestions: z
    .array(
      z.object({
        kind: z.enum(['table', 'diagram', 'chart', 'code', 'image']),
        shows: z.string().min(1).max(300),
        where: z.string().min(1).max(200),
      }),
    )
    .max(8),
})

/** `verdict_first` is required when the draft leads with its verdict and optional otherwise (stripped in code). */
const reviewSchema = (verdictFirst: boolean) =>
  verdictFirst
    ? REVIEW.refine((review) => review.scores.verdict_first !== undefined, {
        message: 'scores.verdict_first is required',
      })
    : REVIEW

export const proseReviewInput = z.object({
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROSE_PROMPT_CHARS)
    .describe('The whole review prompt: instructions, rubric and the fenced draft. The caller builds it'),
  verdictFirst: z
    .boolean()
    .default(true)
    .describe('false: the author builds criteria → candidates → verdict; the answer carries no verdict_first score'),
})

export const proseReviewOutput = REVIEW.extend({ model: z.string() })

/** The id prefix of the writer's lab: the writer is the calling Claude Code session, always Anthropic. */
const WRITER_LAB_PREFIX = 'claude-'

/** The first model of the route (and its fallback) that belongs to the writer's lab, or null. */
function sameLabModel(route: ResolvedRoute): string | null {
  const models = [route.model, fallbackRoute(route)?.model]
  return models.find((model) => model?.toLowerCase().startsWith(WRITER_LAB_PREFIX)) ?? null
}

/**
 * Refuses a review route on the writer's lab, at definition time (a boot with `AGW_ROUTES` pointing `prose.review`
 * at an Anthropic model fails here, not on the first call): a reviewer from the writer's own lab is the same-lab
 * review the cross-lab rule exists to prevent. A malformed override is not this check's to report: it stays the
 * `NOT_CONFIGURED` of the first call, as for every other capability.
 */
export function assertCrossLab(deps: LlmDeps) {
  let route: ResolvedRoute
  try {
    route = resolve(deps, 'prose.review')
  } catch (error) {
    if (error instanceof CapabilityError) return
    throw error
  }
  const offending = sameLabModel(route)
  if (offending) {
    throw new CapabilityError(
      'NOT_CONFIGURED',
      `prose.review: route model ${offending} is from the writer's lab (the calling session is Anthropic); the reviewer must be a different lab`,
    )
  }
}

export const createProseReview = (deps: LlmDeps) => {
  assertCrossLab(deps)
  return defineCapability({
    id: 'prose.critique',
    summary:
      'The cross-lab prose reviewer: one non-agentic call that scores a draft and returns notes (route prose.review)',
    input: proseReviewInput,
    output: proseReviewOutput,
    // Not `agw prose critique`: `agw prose` is the family of the prose workflows.
    cli: { command: ['prose-critique'], stdin: 'prompt', defaultFormat: 'json' },
    async handler({ prompt, verdictFirst }, ctx) {
      const { data, route } = await completeJson(deps, {
        routeId: 'prose.review',
        prompt,
        schema: reviewSchema(verdictFirst),
        effort: 'medium',
        ctx,
      })
      // Code, not the reviewer's compliance, decides that a deliberate build-up gets no verdict score.
      const { verdict_first: _dropped, ...otherScores } = data.scores
      const scores = verdictFirst ? data.scores : otherScores
      const notes = verdictFirst ? data.notes : data.notes.filter((n) => n.criterion !== 'verdict_first')
      return { scores, notes, visualSuggestions: data.visualSuggestions, model: route.model }
    },
  })
}
