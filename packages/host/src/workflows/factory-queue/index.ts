import { factoryQueueOutput, guardQueue } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryQueueScorer } from './scorer.ts'
import { FactoryQueueInput, FactoryQueueOutput } from './schema.ts'

const FACTORY_QUEUE_WORKFLOW_ID = 'factory-queue'
const FACTORY_QUEUE_VERSION = '2026-11-21.1'

/** The one capability the workflow calls; any registry that has `factory.queue` fits. */
export type QueueCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-queue`: software-factory's queue loop asks, when the order of a repo's open Issues is unclear, for `after` edges
 * the work implies and an order for the queued ones. One journaled step, one tool-free `factory.queue` call on its route; the
 * answer is schema-checked and then held to `guardQueue`: only Issues the request showed, no cycle, the owner's priority
 * untouched. A failing step fails the run.
 */
export function createFactoryQueue(deps: { registry: QueueCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_QUEUE_WORKFLOW_ID,
    version: FACTORY_QUEUE_VERSION,
    input: FactoryQueueInput,
    output: FactoryQueueOutput,
    scorer: factoryQueueScorer,
    async run(ctx, { queue }) {
      const answer = await ctx.step('queue', ({ callContext }) =>
        deps.registry.call('factory.queue', queue, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too, and parsed again so a
      // journaled answer that still carries a field the answer no longer has (`drop`) loses it; a replayed step is not re-parsed.
      return guardQueue(factoryQueueOutput.parse(answer), queue)
    },
  })
  return {
    workflow,
    summary:
      "Propose `after` edges, an order for a repo's queued Issues, never against the owner's priority; the queue JSON comes on stdin",
    cli: { stdin: 'queue', defaultFormat: 'json', serverOnly: true },
  }
}
