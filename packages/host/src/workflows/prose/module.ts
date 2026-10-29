import { defineWorkflowModule } from '../registry.ts'
import { createProseWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'prose', create: (deps) => createProseWorkflows(deps), suite: 'plain' })
