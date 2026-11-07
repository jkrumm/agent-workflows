import { defineWorkflowModule } from '../registry.ts'
import { createFactoryQueue } from './index.ts'

/** No `suite`: `factory-queue` has no eval set (owner decision); it learns from real queues in the run journal. */
export default defineWorkflowModule({
  id: 'factory-queue',
  create: (deps) => [createFactoryQueue({ registry: deps.registry })],
})
