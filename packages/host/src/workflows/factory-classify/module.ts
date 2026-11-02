import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryClassify } from './index.ts'

/**
 * The eval set is committed beside the module, unlike the other suites: every case is built from public material (this
 * repo's commits and Issues, the factory's public backlog, alert shapes with placeholder names), so a release carries
 * it and `agw eval run factory-classify` needs no seeding. Add private cases to the same file only after scrubbing.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'factory-classify',
  create: (deps) => [createFactoryClassify({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
