import type { LlmDeps } from '../llm/model-call.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createNarrativeCompose } from './narrative-compose.ts'
import { createProseReview } from './prose-review.ts'
import { createProseWrite } from './prose-write.ts'
import { createReviewAdversary } from './review-adversary.ts'
import { createReviewRoute } from './review-route.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'
import { createTriage } from './triage.ts'

/** The model-backed capabilities: one single call each on its route. */
export function createLlmCapabilities(deps: LlmDeps) {
  return [
    createSummarize(deps),
    createTitle(deps),
    createClassify(deps),
    createDecide(deps),
    createTriage(deps),
    createReviewRoute(deps),
    createReviewAdversary(deps),
    createProseReview(deps),
    createProseWrite(deps),
    createNarrativeCompose(deps),
  ] as const
}
