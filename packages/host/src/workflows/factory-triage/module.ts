import { defineWorkflowModule } from '../registry.ts'
import { createFactoryTriage } from './index.ts'

/** No `suite`: `factory-triage` has no eval set (owner decision); it learns from real signals in the run journal. */
export default defineWorkflowModule({
  id: 'factory-triage',
  create: (deps) => [createFactoryTriage({ registry: deps.registry })],
})
