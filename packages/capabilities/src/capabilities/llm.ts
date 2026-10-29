import type { LlmDeps } from '../llm/model-call.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createProseReview } from './prose-review.ts'
import { createReviewAdversary } from './review-adversary.ts'
import { createReviewRoute } from './review-route.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'

/** The model-backed capabilities: one single call each on its route. */
export function createLlmCapabilities(deps: LlmDeps) {
  return [
    createSummarize(deps),
    createTitle(deps),
    createClassify(deps),
    createDecide(deps),
    createReviewRoute(deps),
    createReviewAdversary(deps),
    createProseReview(deps),
  ] as const
}
