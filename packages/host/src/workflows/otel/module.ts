import { defineWorkflowModule } from '../registry.ts'
import { createOtelWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'otel', create: (deps) => createOtelWorkflows(deps), suite: 'plain' })
