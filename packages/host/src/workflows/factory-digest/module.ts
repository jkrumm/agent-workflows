import { defineWorkflowModule } from '../registry.ts'
import { createFactoryDigest } from './index.ts'

/** No `suite`: `factory.digest` has no eval set; the guard holds the answer to the request. */
export default defineWorkflowModule({
  id: 'factory-digest',
  create: (deps) => [createFactoryDigest({ registry: deps.registry })],
})
