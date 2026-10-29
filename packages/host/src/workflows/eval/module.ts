import { defineWorkflowModule } from '../registry.ts'
import { createEvalWorkflows } from './index.ts'

/** `agw eval run|compare` over every discovered module's suite; `wireEval` binds them to the runtime at boot. */
export default defineWorkflowModule({ id: 'eval', create: (_deps, { suites }) => createEvalWorkflows(suites) })
