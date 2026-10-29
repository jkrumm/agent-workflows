import { defineWorkflowModule } from '../registry.ts'
import { createDiagramWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'diagram', create: (deps) => createDiagramWorkflows(deps), suite: 'plain' })
