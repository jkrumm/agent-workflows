import { join } from 'node:path'
import { agentNames, defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createRetrospective } from './index.ts'

/**
 * The eval set, committed beside the module: runs written for the set (a planted pattern each, one healthy control), run
 * as the `fixture` input. A host without a database serves no `retrospective` and still lists the suite: the registry
 * allows a suite on a module that built nothing there.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

/** `last`: the retrospective is told the agents of every other workflow; a host without a database serves none. */
export default defineWorkflowModule({
  id: 'retrospective',
  phase: 'last',
  create: (deps, { peers }) => {
    if (!deps.retro) return []
    const { journal, learnings, gh, tracked } = deps.retro
    const agents = agentNames([...peers])
    return [createRetrospective({ journal, learnings, gh, tracked, agentsOf: (id) => agents.get(id) })]
  },
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
