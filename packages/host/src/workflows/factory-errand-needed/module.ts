import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryErrandNeeded } from './index.ts'

/** The eval set is committed beside the module: every case is public placeholder material (example-app, e_N). */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'factory-errand-needed',
  create: (deps) => [createFactoryErrandNeeded({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
