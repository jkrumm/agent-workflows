import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'

/** The first capabilities, all model-backed. `deps` defaults to the production IU adapters on `process.env`. */
export function createCapabilities(deps: LlmDeps = { transports: iuTransports() }) {
  return [createSummarize(deps), createTitle(deps), createClassify(deps), createDecide(deps)] as const
}
