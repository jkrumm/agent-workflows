import { defineWorkflowModule } from '../registry.ts'
import { createEvalWorkflows } from './index.ts'

/**
 * `agw eval run|compare` over every discovered module's suite; `wireEval` binds them to the runtime at boot. A tree
 * without suites (a second process's) serves no eval commands rather than failing on an empty enum.
 */
export default defineWorkflowModule({
  id: 'eval',
  create: (_deps, { suites }) => (suites.size ? createEvalWorkflows(suites) : []),
})
