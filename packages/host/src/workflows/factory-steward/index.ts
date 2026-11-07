import { guardSteward, stewardUnavailable } from '@agent-workflows/capabilities'
import { Cancelled, defineWorkflow, InfraError, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryStewardInput, FactoryStewardOutput } from './schema.ts'

const FACTORY_STEWARD_WORKFLOW_ID = 'factory-steward'
const FACTORY_STEWARD_VERSION = '2026-11-07.1'

/** The one capability the workflow calls; any registry that has `factory.steward` fits. */
export type StewardCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-steward`: software-factory's supervisor asks what a stalled Issue needs when its own rules do not say. One
 * journaled step, one tool-free `factory.steward` call on its route; the answer is schema-checked and then held to
 * `guardSteward`. Fails closed: a steward that cannot answer says `none` instead of failing the run, and the factory raises
 * a Decision of its own after a few such answers.
 */
export function createFactorySteward(deps: { registry: StewardCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_STEWARD_WORKFLOW_ID,
    version: FACTORY_STEWARD_VERSION,
    input: FactoryStewardInput,
    output: FactoryStewardOutput,
    async run(ctx, { stall }) {
      try {
        const answer = await ctx.step('steward', ({ callContext }) =>
          deps.registry.call('factory.steward', stall, callContext),
        )
        // Outside the step: an answer journaled before the guard existed is held to it on replay too.
        return guardSteward(answer, stall)
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the answer.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return stewardUnavailable(`steward unavailable: ${error instanceof StepFailed ? error.stepKind : 'error'}`)
      }
    },
  })
  return {
    workflow,
    summary:
      'Decide what a stalled Issue needs: wake it, requeue it, or raise a Decision; the stall JSON comes on stdin',
    cli: { stdin: 'stall', defaultFormat: 'json' },
  }
}
