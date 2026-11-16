import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryFixClasses } from './index.ts'

/** The eval set is committed beside the module: fix commits of this public repo (real shas, subjects, bodies and paths) and two written ones. */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'factory-fix-classes',
  create: (deps) => [createFactoryFixClasses({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
