import { guardQueue, queueNone } from '@agent-workflows/capabilities'
import { Cancelled, defineWorkflow, InfraError, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryQueueInput, FactoryQueueOutput } from './schema.ts'

const FACTORY_QUEUE_WORKFLOW_ID = 'factory-queue'
const FACTORY_QUEUE_VERSION = '2026-11-08.1'

/** The one capability the workflow calls; any registry that has `factory.queue` fits. */
export type QueueCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-queue`: software-factory's queue loop asks, when the order of a repo's open Issues is unclear, for `after` edges
 * the work implies and an order for the queued ones. One journaled step, one tool-free `factory.queue` call on its route; the
 * answer is schema-checked and then held to `guardQueue`: only Issues the request showed, no cycle, the owner's priority
 * untouched. Fails closed to the empty answer (no edges, the factory's order) instead of failing the run.
 */
export function createFactoryQueue(deps: { registry: QueueCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_QUEUE_WORKFLOW_ID,
    version: FACTORY_QUEUE_VERSION,
    input: FactoryQueueInput,
    output: FactoryQueueOutput,
    async run(ctx, { queue }) {
      try {
        const answer = await ctx.step('queue', ({ callContext }) =>
          deps.registry.call('factory.queue', queue, callContext),
        )
        // Outside the step: an answer journaled before the guard existed is held to it on replay too.
        return guardQueue(answer, queue)
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the answer.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return queueNone(`queue unavailable: ${error instanceof StepFailed ? error.stepKind : 'error'}`)
      }
    },
  })
  return {
    workflow,
    summary:
      "Propose `after` edges and an order for a repo's queued Issues, never against the owner's priority; the queue JSON comes on stdin",
    cli: { stdin: 'queue', defaultFormat: 'json' },
  }
}
