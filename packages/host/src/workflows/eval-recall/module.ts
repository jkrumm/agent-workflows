import { defineWorkflowModule } from '../registry.ts'
import { createEvalRecall } from './index.ts'

/** `agw eval recall`: the ground-truth cases through review v4's hidden transport, scored. Needs the host's review service. */
export default defineWorkflowModule({
  id: 'eval-recall',
  create: (deps) => (deps.review ? createEvalRecall({ review: deps.review, registry: deps.registry }) : []),
})
