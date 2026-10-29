import { defineWorkflowModule } from '../registry.ts'
import { createProsePolish } from './index.ts'

export default defineWorkflowModule({
  id: 'prose-polish',
  create: (deps) => [createProsePolish({ registry: deps.registry })],
})
