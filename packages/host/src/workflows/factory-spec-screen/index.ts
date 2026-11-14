import { guardSpecScreen } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factorySpecScreenScorer } from './scorer.ts'
import { FactorySpecScreenInput, FactorySpecScreenOutput } from './schema.ts'

const FACTORY_SPEC_SCREEN_WORKFLOW_ID = 'factory-spec-screen'
const FACTORY_SPEC_SCREEN_VERSION = '2026-11-14.1'

/** The one capability the workflow calls; any registry that has `factory.specscreen` fits. */
export type SpecScreenCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-spec-screen`: before a Spec reaches the owner, software-factory asks whether it is his to read (`pass`) or its
 * lead's to decide (`settle`). One journaled step, one tool-free `factory.specscreen` call on its route; the answer is
 * schema-checked and then held to `guardSpecScreen`. It does not fail closed: a failed call fails the run, because the factory
 * retries the screen and, failing that, lets the Spec reach the owner unscreened.
 */
export function createFactorySpecScreen(deps: { registry: SpecScreenCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_SPEC_SCREEN_WORKFLOW_ID,
    version: FACTORY_SPEC_SCREEN_VERSION,
    input: FactorySpecScreenInput,
    output: FactorySpecScreenOutput,
    scorer: factorySpecScreenScorer,
    async run(ctx, { request }) {
      const answer = await ctx.step('spec-screen', ({ callContext }) =>
        deps.registry.call('factory.specscreen', { request }, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too.
      return guardSpecScreen(answer)
    },
  })
  return {
    workflow,
    summary:
      "Whether a Spec is the owner's to read (pass) or its lead's to decide (settle), with a one-line reason; the request JSON comes on stdin",
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
