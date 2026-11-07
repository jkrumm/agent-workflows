import { defineWorkflowModule } from '../registry.ts'
import { createFactorySteward } from './index.ts'

/** No `suite`: `factory-steward` has no eval set (owner decision); it learns from real stalls in the run journal. */
export default defineWorkflowModule({
  id: 'factory-steward',
  create: (deps) => [createFactorySteward({ registry: deps.registry })],
})
