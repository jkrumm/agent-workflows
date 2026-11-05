import { defineWorkflowModule } from '../registry.ts'
import { createFactoryAsk } from './index.ts'

/** No `suite`: `factory-ask` has no eval set (owner decision); it learns from real asks in the run journal. */
export default defineWorkflowModule({
  id: 'factory-ask',
  create: (deps) => [createFactoryAsk({ registry: deps.registry })],
})
