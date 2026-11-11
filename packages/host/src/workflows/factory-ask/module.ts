import { FACTORY_ASK_CASES_PATH } from '@agent-workflows/eval'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryAsk } from './index.ts'

/**
 * The eval set is committed in the eval package (`packages/eval/factory-ask/cases.jsonl`): real Decisions of the factory,
 * scrubbed of private names, so a release carries it and `agw eval run factory-ask` needs no seeding.
 */
export default defineWorkflowModule({
  id: 'factory-ask',
  create: (deps) => [createFactoryAsk({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(FACTORY_ASK_CASES_PATH) },
})
