import type { HostDeps } from '../../../../host/src/workflows/index.ts'
import { defineWorkflowModule } from '../../../../host/src/workflows/registry.ts'
import { brainCapabilities, brainPort } from './brain.ts'
import { postgresJournal, postgresHistory, type Queryable } from './history.ts'
import { createPodcastWorkflow, type PodcastDeps } from './index.ts'
import { researchClient, researchClientFromEnv } from './research-client.ts'

// The `podcast` workflow's registration in the audio process's workflow tree (host `workflows/registry.ts`). The
// audio process discovers `packages/audio/src/workflows/*/module.ts` like the host discovers its own tree; nothing in
// the host's tree imports this file.
//
// Beyond `HostDeps` the room reads the journal (the show's memory, the episode's recorded cost): the audio process
// passes its journal pool and schema as `journal`. `last` phase: the room picks up `podcast.produce` from the modules
// built before it, when one is registered, so neither module imports the other.

/** What the audio process adds to `HostDeps` for this module. */
export type PodcastModuleDeps = HostDeps & { journal?: { db: Queryable; schema: string } }

export default defineWorkflowModule({
  id: 'podcast',
  phase: 'last',
  create(deps, { peers }) {
    const { journal } = deps as PodcastModuleDeps
    if (!journal) throw new Error('podcast module: the process must pass `journal` ({ db, schema }) in its deps')
    const research = researchClientFromEnv(process.env, 'prod')
    const produce = peers.find((p) => p.workflow.id === 'podcast.produce')?.workflow as PodcastDeps['produce']
    const podcast = createPodcastWorkflow({
      history: postgresHistory(journal.db, journal.schema),
      journal: postgresJournal(journal.db, journal.schema),
      brain: brainPort(brainCapabilities(deps.registry.capabilities)),
      ...(research ? { research: researchClient(research) } : {}),
      ...(produce ? { produce } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    })
    return [
      {
        workflow: podcast,
        summary: 'Turn notes into a two-host podcast episode: research, editorial, script, then produce and publish',
        cli: { positional: ['source'], stdin: 'source', defaultFormat: 'json' },
      },
    ]
  },
})
