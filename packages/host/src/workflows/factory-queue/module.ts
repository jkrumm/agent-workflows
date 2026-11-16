import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryQueue } from './index.ts'

/** The eval set is committed beside the module: real queue snapshots rewritten to placeholder repos, titles and ids. */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'factory-queue',
  create: (deps) => [createFactoryQueue({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
