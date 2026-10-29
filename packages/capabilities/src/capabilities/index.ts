import type { LlmDeps } from '../llm/model-call.ts'
import { createHdxCapabilities, type HdxDeps } from '../hdx/index.ts'
import { iuTransports } from '../transports/index.ts'
import { createWebCapabilities, type WebDeps } from '../web/index.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createProseReview } from './prose-review.ts'
import { createReviewAdversary } from './review-adversary.ts'
import { createReviewRoute } from './review-route.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'

/** The model-backed capabilities, the research tools and the HyperDX API. `deps`, `web` and `hdx` default to production on `process.env`. */
export function createCapabilities(
  deps: LlmDeps = { transports: iuTransports() },
  web: WebDeps = {},
  hdx: HdxDeps = {},
) {
  return [
    createSummarize(deps),
    createTitle(deps),
    createClassify(deps),
    createDecide(deps),
    createReviewRoute(deps),
    createReviewAdversary(deps),
    createProseReview(deps),
    ...createWebCapabilities(web),
    ...createHdxCapabilities(hdx),
  ] as const
}
