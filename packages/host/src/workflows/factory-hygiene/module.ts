import { defineWorkflowModule } from '../registry.ts'
import { createFactoryHygiene } from './index.ts'

/** No `suite`: `factory-hygiene` has no eval set (owner decision); the guard bounds what it can say. */
export default defineWorkflowModule({
  id: 'factory-hygiene',
  create: () => [createFactoryHygiene()],
})
