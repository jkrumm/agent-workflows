import { defineWorkflowModule } from '../registry.ts'
import { depthSuite } from '../suite.ts'
import { createResearchWorkflows } from './index.ts'

export default defineWorkflowModule({
  id: 'research',
  create: (deps) => createResearchWorkflows(deps),
  suite: depthSuite,
})
