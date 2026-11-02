import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createDigest } from './index.ts'

/**
 * The eval set is committed beside the module, as `factory-classify`'s is: every case is built from public material (the
 * wave headings of public repos' plans, replies and fact lists written for the set), so a release carries it and
 * `agw eval run digest` needs no seeding.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'digest',
  create: (deps) => [createDigest({ registry: deps.registry })],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
