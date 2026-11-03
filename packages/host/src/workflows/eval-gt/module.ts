import { defineWorkflowModule } from '../registry.ts'
import { createEvalGtWorkflows } from './index.ts'

/** `agw eval gt calibrate`: the agreement of the two judges (`docs/review-v2.md` §Matching and judging). */
export default defineWorkflowModule({
  id: 'eval-gt',
  create: (deps) => createEvalGtWorkflows({ registry: deps.registry }),
})
