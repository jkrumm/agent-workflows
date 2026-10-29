import { defineWorkflowModule } from '../registry.ts'
import { createImageWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'image', create: (deps) => createImageWorkflows(deps), suite: 'plain' })
