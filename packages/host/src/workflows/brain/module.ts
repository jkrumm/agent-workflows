import { defineWorkflowModule } from '../registry.ts'
import { createBrainWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'brain', create: (deps) => createBrainWorkflows(deps), suite: 'plain' })
