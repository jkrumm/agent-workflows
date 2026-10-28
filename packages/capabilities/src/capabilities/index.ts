import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createWebCapabilities, type WebDeps } from '../web/index.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createReviewAdversary } from './review-adversary.ts'
import { createReviewRoute } from './review-route.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'

/** The model-backed capabilities and the research tools. `deps` and `web` default to production on `process.env`. */
export function createCapabilities(deps: LlmDeps = { transports: iuTransports() }, web: WebDeps = {}) {
  return [
    createSummarize(deps),
    createTitle(deps),
    createClassify(deps),
    createDecide(deps),
    createReviewRoute(deps),
    createReviewAdversary(deps),
    ...createWebCapabilities(web),
  ] as const
}
