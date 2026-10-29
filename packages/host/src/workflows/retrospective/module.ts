import { agentNames, defineWorkflowModule } from '../registry.ts'
import { createRetrospective } from './index.ts'

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
