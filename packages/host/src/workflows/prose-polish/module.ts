import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createProsePolish } from './index.ts'

/**
 * The eval set is committed beside the module: short drafts written for the set, each with planted lint issues (a
 * banned word, a parallelism, a German nominal style), so a release carries it and `agw eval run prose-polish` needs no seeding.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'prose-polish',
  create: (deps) => [createProsePolish({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
