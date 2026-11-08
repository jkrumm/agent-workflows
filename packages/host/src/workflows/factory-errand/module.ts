import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryErrand } from './index.ts'

/** The eval set is committed beside the module: every case is public placeholder material (example-app, issue_N). */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'factory-errand',
  create: (deps) => [createFactoryErrand({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
