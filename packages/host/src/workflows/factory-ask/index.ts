import { askOfJudge, factoryAskInput, guardAsk, guardJudge } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryAskScorer } from './scorer.ts'
import { FactoryAskInput, FactoryAskOutput, type FactoryAskOutputValue } from './schema.ts'

const FACTORY_ASK_WORKFLOW_ID = 'factory-ask'
const FACTORY_ASK_VERSION = '2026-11-21.1'

/** The one capability the workflow calls; any registry that has `factory.ask` fits. */
export type AskCaller = Pick<HostRegistry, 'call'>

/** The verdict for an ask the seat cannot take whole: it stays the owner's. */
const ownersAsk = (why: string): FactoryAskOutputValue => ({
  verdict: 'owner',
  answer: '',
  source: '',
  reason: `judge unavailable: ${why}`,
})

/**
 * `factory-ask`: software-factory's check on a lead's `factory issue ask`. One journaled step, one tool-free
 * `factory.ask` call on its route; the verdict is schema-checked and then held to `guardAsk`. The ask is fenced as data
 * inside the capability. A judge that cannot answer fails the run; only an ask the seat cannot take whole is the owner's.
 */
export function createFactoryAsk(deps: { registry: AskCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_ASK_WORKFLOW_ID,
    version: FACTORY_ASK_VERSION,
    input: FactoryAskInput,
    output: FactoryAskOutput,
    scorer: factoryAskScorer,
    async run(ctx, { ask: given }) {
      // The Decision is asked as the seat's ask (its options are the labels); the guard for what an ask cannot say follows.
      const ask = askOfJudge(given)
      // A Decision whose assembled facts pass the seat's cap is refused whole, never cut: the owner's.
      if (!factoryAskInput.safeParse(ask).success) return ownersAsk('the ask is too long for the seat')
      const verdict = await ctx.step('judge', ({ callContext }) => deps.registry.call('factory.ask', ask, callContext))
      // Outside the step: a verdict journaled before the guard existed is held to it on replay too.
      const guarded = guardAsk(verdict, ask)
      return guardJudge(guarded, given)
    },
  })
  return {
    workflow,
    summary:
      "Decide whether a lead's factory ask is the owner's or answerable from the plan or the declared default; the ask JSON comes on stdin",
    cli: { stdin: 'ask', defaultFormat: 'json', serverOnly: true },
  }
}
