import { join } from 'node:path'
import { agentNames, defineWorkflowModule } from '../registry.ts'
import { createRetrospective } from './index.ts'

/**
 * The eval set, committed beside the module: runs written for the set (a planted pattern each, one healthy control), run
 * as the `fixture` input. Not yet registered as the module's `suite`: `buildWorkflows` refuses a suite on a host that
 * serves no `retrospective` (no database), which `createWorkflows({ registry, toolGate })` is.
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
})
