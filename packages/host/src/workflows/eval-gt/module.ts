import { defineWorkflowModule } from '../registry.ts'
import { createEvalGtWorkflows } from './index.ts'

/** `agw eval gt pack|ingest`: the owner session of the review ground truth (`docs/review-v2.md` §Ground truth step 5). */
export default defineWorkflowModule({
  id: 'eval-gt',
  create: () => createEvalGtWorkflows(),
})
