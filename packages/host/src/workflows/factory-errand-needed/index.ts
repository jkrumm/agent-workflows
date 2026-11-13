import { guardErrandNeeded } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryErrandNeededScorer } from './scorer.ts'
import { FactoryErrandNeededInput, FactoryErrandNeededOutput } from './schema.ts'

const FACTORY_ERRAND_NEEDED_WORKFLOW_ID = 'factory-errand-needed'
const FACTORY_ERRAND_NEEDED_VERSION = '2026-11-13.1'

/** The one capability the workflow calls; any registry that has `factory.errandneeded` fits. */
export type ErrandNeededCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-errand-needed`: once a day software-factory asks whether an open request for the owner's hands, one with no `check`
 * command, is still needed: needed, not_needed or unsure. One journaled step, one tool-free `factory.errandneeded` call on its
 * route; the answer is schema-checked and then held to `guardErrandNeeded`. It does not fail closed: a failed call fails the
 * run, because the factory leaves the request open, names the failure and asks again.
 */
export function createFactoryErrandNeeded(deps: { registry: ErrandNeededCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_ERRAND_NEEDED_WORKFLOW_ID,
    version: FACTORY_ERRAND_NEEDED_VERSION,
    input: FactoryErrandNeededInput,
    output: FactoryErrandNeededOutput,
    scorer: factoryErrandNeededScorer,
    async run(ctx, { request }) {
      const answer = await ctx.step('errand-needed', ({ callContext }) =>
        deps.registry.call('factory.errandneeded', { request }, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too.
      return guardErrandNeeded(answer, request.evidence)
    },
  })
  return {
    workflow,
    summary:
      "Whether an open request for the owner's hands is still needed: needed, not_needed or unsure; the request JSON comes on stdin",
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
