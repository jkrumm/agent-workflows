import { askOfJudge, factoryAskInput, guardAsk, guardJudge, isJudgeInput } from '@agent-workflows/capabilities'
import { Cancelled, defineWorkflow, InfraError, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryAskInput, FactoryAskOutput, type FactoryAskOutputValue } from './schema.ts'

const FACTORY_ASK_WORKFLOW_ID = 'factory-ask'
const FACTORY_ASK_VERSION = '2026-11-07.1'

/** The one capability the workflow calls; any registry that has `factory.ask` fits. */
export type AskCaller = Pick<HostRegistry, 'call'>

/** The verdict when the judge cannot answer: the ask stays the owner's. The class is a short label, never the error text. */
const unavailable = (cls: string): FactoryAskOutputValue => ({
  verdict: 'owner',
  answer: '',
  source: '',
  reason: `judge unavailable: ${cls}`,
})

/**
 * `factory-ask`: software-factory's check on a lead's `factory issue ask`. One journaled step, one tool-free
 * `factory.ask` call on its route; the verdict is schema-checked and then held to `guardAsk`. The ask is fenced as data
 * inside the capability. Fails closed: a judge that cannot answer leaves the ask with the owner instead of failing the run.
 */
export function createFactoryAsk(deps: { registry: AskCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_ASK_WORKFLOW_ID,
    version: FACTORY_ASK_VERSION,
    input: FactoryAskInput,
    output: FactoryAskOutput,
    async run(ctx, { ask: given }) {
      // The Decision is asked as today's ask (its options are the labels); the guard for what an ask cannot say follows.
      const ask = isJudgeInput(given) ? askOfJudge(given) : given
      // A Decision whose assembled facts pass the seat's cap is refused whole, never cut: the owner's.
      if (!factoryAskInput.safeParse(ask).success) return unavailable('the ask is too long for the seat')
      try {
        const verdict = await ctx.step('judge', ({ callContext }) =>
          deps.registry.call('factory.ask', ask, callContext),
        )
        // Outside the step: a verdict journaled before the guard existed is held to it on replay too.
        const guarded = guardAsk(verdict, ask)
        return isJudgeInput(given) ? guardJudge(guarded, given) : guarded
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the verdict.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return unavailable(error instanceof StepFailed ? error.stepKind : 'error')
      }
    },
  })
  return {
    workflow,
    summary:
      "Decide whether a lead's factory ask is the owner's or answerable from the plan or the declared default; the ask JSON comes on stdin",
    cli: { stdin: 'ask', defaultFormat: 'json' },
  }
}
