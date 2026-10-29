import { createLearningsWorkflows } from '../../learnings/index.ts'
import { defineWorkflowModule } from '../registry.ts'

/** The learnings commands live with the store (`src/learnings/`); a host without a database serves none. */
export default defineWorkflowModule({
  id: 'learnings',
  create: (deps) => (deps.retro ? createLearningsWorkflows(deps.retro.learnings) : []),
})
