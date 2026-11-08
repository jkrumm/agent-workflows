import { guardErrand } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryErrandScorer } from './scorer.ts'
import { FactoryErrandInput, FactoryErrandOutput } from './schema.ts'

const FACTORY_ERRAND_WORKFLOW_ID = 'factory-errand'
const FACTORY_ERRAND_VERSION = '2026-11-08.1'

/** The one capability the workflow calls; any registry that has `factory.errand` fits. */
export type ErrandCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-errand`: software-factory screens an Errand (a lead's "I need the owner's hands") before the owner is paged:
 * pass or turn_away. One journaled step, one tool-free `factory.errand` call on its route; the answer is schema-checked and
 * then held to `guardErrand`. It does not fail closed: a failed call fails the run, because the factory records a failed call
 * with a backoff and retries.
 */
export function createFactoryErrand(deps: { registry: ErrandCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_ERRAND_WORKFLOW_ID,
    version: FACTORY_ERRAND_VERSION,
    input: FactoryErrandInput,
    output: FactoryErrandOutput,
    scorer: factoryErrandScorer,
    async run(ctx, { request }) {
      const answer = await ctx.step('errand', ({ callContext }) =>
        deps.registry.call('factory.errand', { request }, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too.
      return guardErrand(answer)
    },
  })
  return {
    workflow,
    summary: 'Screen an Errand before the owner sees it: pass or turn_away; the request JSON comes on stdin',
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
