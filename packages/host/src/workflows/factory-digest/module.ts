import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createFactoryDigest, FACTORY_DIGEST_WORKFLOW_ID } from './index.ts'

/** The eval set is committed beside the module: project snapshots written to the prompt's rules, in placeholder ids and titles. */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

/** The module's directory is `factory-digest`, the workflow's id is `factory.digest`: the suite names the workflow it replays. */
export default defineWorkflowModule({
  id: 'factory-digest',
  create: (deps) => [createFactoryDigest({ registry: deps.registry })],
  suite: { workflow: FACTORY_DIGEST_WORKFLOW_ID, read: () => plainSuite.read(CASES_PATH) },
})
