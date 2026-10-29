import { defineWorkflowModule } from '../registry.ts'
import { createNarrative } from './index.ts'

export default defineWorkflowModule({
  id: 'narrative',
  create: (deps) => createNarrative({ registry: deps.registry, logger: deps.logger }),
})
