import {
  DEFAULT_STEWARD_WORDING,
  guardSteward,
  STEWARD_WORDINGS,
  type StewardWording,
} from '@agent-workflows/capabilities'
import { defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryStewardScorer } from './scorer.ts'
import { FactoryStewardInput, FactoryStewardOutput } from './schema.ts'

const FACTORY_STEWARD_WORKFLOW_ID = 'factory-steward'
const FACTORY_STEWARD_VERSION = '2026-11-16.1'

/** The one capability the workflow calls; any registry that has `factory.steward` fits. */
export type StewardCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-steward`: software-factory's supervisor asks what a stalled Issue needs when its own rules do not say. One
 * journaled step, one tool-free `factory.steward` call on its route; the answer is schema-checked and then held to
 * `guardSteward`. A step that fails fails the run; the guard turns an answer it refuses into `none`.
 */
export function createFactorySteward(deps: { registry: StewardCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_STEWARD_WORKFLOW_ID,
    version: FACTORY_STEWARD_VERSION,
    input: FactoryStewardInput,
    output: FactoryStewardOutput,
    scorer: factoryStewardScorer,
    async run(ctx, { stall }) {
      // An eval arm's prompt wording (`--arm` with `params.stewardWording`); production runs carry none and send the stall as is.
      const wording = ctx.param('stewardWording', DEFAULT_STEWARD_WORDING)
      if (!STEWARD_WORDINGS.some((w) => w === wording))
        throw new WorkflowError(
          'invalid_input',
          `arm param stewardWording must be one of ${STEWARD_WORDINGS.join(', ')}`,
        )
      const call = wording === DEFAULT_STEWARD_WORDING ? stall : { ...stall, wording: wording as StewardWording }
      const answer = await ctx.step('steward', ({ callContext }) =>
        deps.registry.call('factory.steward', call, callContext),
      )
      // Outside the step: an answer journaled before the guard existed is held to it on replay too.
      return guardSteward(answer, stall)
    },
  })
  return {
    workflow,
    summary:
      'Decide what a stalled Issue needs: wake it, requeue it, or raise a Decision; the stall JSON comes on stdin',
    cli: { stdin: 'stall', defaultFormat: 'json', serverOnly: true },
  }
}
