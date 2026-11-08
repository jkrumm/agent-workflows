import { defineWorkflowModule } from '../registry.ts'
import { createFactoryFixClasses } from './index.ts'

/** No `suite`: `factory-fix-classes` has no eval set; the schema holds the answer to the request. */
export default defineWorkflowModule({
  id: 'factory-fix-classes',
  create: (deps) => [createFactoryFixClasses({ registry: deps.registry })],
})
