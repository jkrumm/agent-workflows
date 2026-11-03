import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createNarrative } from './index.ts'

/**
 * The eval set is committed beside the module: every case is a `fixture` of synthetic commits (placeholder projects,
 * no real history), run with `polish: false` so the score is the composer's and the spend is one call per case.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'narrative',
  create: (deps) => createNarrative({ registry: deps.registry, logger: deps.logger }),
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
