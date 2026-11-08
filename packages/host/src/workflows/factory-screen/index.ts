import { guardScreen } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryScreenScorer } from './scorer.ts'
import { FactoryScreenInput, FactoryScreenOutput } from './schema.ts'

const FACTORY_SCREEN_WORKFLOW_ID = 'factory-screen'
const FACTORY_SCREEN_VERSION = '2026-11-08.1'

/** The one capability the workflow calls; any registry that has `factory.screen` fits. */
export type ScreenCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-screen`: the Judge of software-factory screens a held signal: promote, dismiss or leave. One journaled step,
 * one tool-free `factory.screen` call on its route; the answer is schema-checked and then held to `guardScreen`: a repo
 * from the projects, a duplicate among the shown Issues, else `leave`. Unlike triage it does not fail closed: a failed
 * call fails the run, because the factory records a failed call with a backoff and retries, whereas a fake `leave` would
 * mark the signal screened for good.
 */
export function createFactoryScreen(deps: { registry: ScreenCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_SCREEN_WORKFLOW_ID,
    version: FACTORY_SCREEN_VERSION,
    input: FactoryScreenInput,
    output: FactoryScreenOutput,
    scorer: factoryScreenScorer,
    async run(ctx, { request }) {
      const answer = await ctx.step('screen', ({ callContext }) =>
        deps.registry.call('factory.screen', { request }, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too.
      return guardScreen(answer, request)
    },
  })
  return {
    workflow,
    summary: 'Screen a held signal for the Judge: promote, dismiss or leave; the request JSON comes on stdin',
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
