import type { HostDeps } from '../../../../host/src/workflows/index.ts'
import { defineWorkflowModule } from '../../../../host/src/workflows/registry.ts'
import type { AudioDeps } from '../../scope.ts'
import type { Queryable } from '../podcast/history.ts'
import { type CoverCall, createProduceWorkflows } from './index.ts'
import { postgresProduceJournal } from './journal.ts'
import { createPublishWorkflow } from './publish.ts'

// Production's registration in the audio process's workflow tree (host `workflows/registry.ts`): the internal
// `podcast.produce` (the room's child, picked up by the `last`-phase `podcast` module from its peers) with its internal
// per-unit child `podcast.produce.unit`, and the public `podcast-publish` follow-up. Beyond `HostDeps` it reads the
// journal (track number, cost, the produced episode) and the audio lanes' deps (`audio`: the door's config and media).

/** What the audio process adds to `HostDeps` for this module. */
export type ProduceModuleDeps = HostDeps & {
  journal?: { db: Queryable; schema: string }
  audio?: Omit<AudioDeps, 'usage'>
}

export default defineWorkflowModule({
  id: 'podcast-produce',
  create(deps) {
    const { journal, audio, logger } = deps as ProduceModuleDeps
    if (!journal)
      throw new Error('podcast-produce module: the process must pass `journal` ({ db, schema }) in its deps')
    if (!audio) throw new Error("podcast-produce module: the process must pass `audio` (the lanes' deps) in its deps")
    const produceJournal = postgresProduceJournal(journal.db, journal.schema)
    const cover = deps.registry.capabilities.find((c) => c.id === 'image.generate') as unknown as CoverCall | undefined
    const { produce, unit } = createProduceWorkflows({
      journal: produceJournal,
      audio,
      ...(cover ? { cover } : {}),
      ...(logger ? { logger } : {}),
    })
    const publish = createPublishWorkflow({ journal: produceJournal, ...(logger ? { logger } : {}) })
    return [
      {
        workflow: produce,
        summary: "Produce a podcast episode from the writers' room's locked script: synth, master, cover, publish",
        internal: true,
      },
      {
        workflow: unit,
        summary: 'One synth unit of podcast.produce (a child run of its synth fan-out)',
        internal: true,
      },
      {
        workflow: publish,
        summary: 'Publish an already produced podcast episode to Audiobookshelf again, then file its brain note',
        cli: { positional: ['runId'], defaultFormat: 'json', mutating: true },
      },
    ]
  },
})
