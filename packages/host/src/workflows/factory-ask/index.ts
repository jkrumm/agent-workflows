import {
  ASK_SUBMIT_RETRY,
  askNonce,
  askOfJudge,
  type AskLook,
  buildFactoryAskPrompt,
  clipAsk,
  factoryAskInput,
  factoryAskOutputFor,
  type FactoryAskInput as AskInput,
  guardAsk,
  guardJudge,
} from '@agent-workflows/capabilities'
import { type Ctx, defineWorkflow, type Json, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { findEscapingLink } from '../factory-hygiene/scan.ts'
import { factoryAskScorer } from './scorer.ts'
import { FactoryAskInput, FactoryAskOutput, type FactoryAskOutputValue } from './schema.ts'

const FACTORY_ASK_WORKFLOW_ID = 'factory-ask'
const FACTORY_ASK_VERSION = '2026-11-21.2'
const ASK_AGENT = 'factory-ask'

/** The verdict for an ask the seat cannot take whole: it stays the owner's. */
const ownersAsk = (why: string): FactoryAskOutputValue => ({
  verdict: 'owner',
  answer: '',
  source: '',
  reason: `judge unavailable: ${why}`,
})

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/**
 * Where the Judge reads. A checkout with a link that leaves it is not handed over (the agent's grant is matched against the
 * path it names, not where a link leads), and neither is one too large to vouch for: the Judge then answers from the request.
 */
export async function lookOf(ctx: Ctx, checkout: string | undefined): Promise<AskLook> {
  if (checkout === undefined) return { none: 'none was named' }
  const scan = await ctx.step('scan', async () => {
    const link = await findEscapingLink(checkout).catch(() => 'the checkout could not be scanned')
    return { link }
  })
  // The link's name is the repo's text, so it stays in the journal and never reaches the prompt's rules.
  return scan.link === null ? { checkout } : { none: 'a link leaves the checkout, or it could not be scanned' }
}

/** One agent step and one retry with the `submit_result` directive; two invalid answers fail the run. */
async function judge(ctx: Ctx, ask: AskInput, prompt: string, look: AskLook): Promise<FactoryAskOutputValue> {
  // Read-only is the agent's own permissions (read, glob, grep: no shell, no edit, no network). No turn limit and no
  // wall-clock ceiling: the idle watchdog is the one stop.
  const options: Json = 'checkout' in look ? { output: 'json', allowDirectories: [look.checkout] } : { output: 'json' }
  const spec = { agent: ASK_AGENT, output: factoryAskOutputFor(ask), options }
  try {
    return await ctx.agent('look', { ...spec, prompt })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
  }
  return ctx.agent('look-retry', { ...spec, prompt: prompt + ASK_SUBMIT_RETRY })
}

/**
 * `factory-ask`: software-factory's Judge on a lead's `factory issue ask`. An agent step with read, glob and grep over the
 * checkout the Decision names: before it says owner it looks at the plan, AGENTS.md, the design guide and the code the
 * question is about, and an answer cites the file and line or the quote it rests on. The verdict is schema-checked (an
 * answer is one of the options) and then held to `guardAsk` and `guardJudge`. A Decision the seat cannot take whole is the
 * owner's; a Judge that cannot answer fails the run.
 */
export function createFactoryAsk(): HostWorkflow {
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
      const look = await lookOf(ctx, given.checkout)
      const prompt = buildFactoryAskPrompt(ask, askNonce(ask, given.case), look, given.case)
      const verdict = clipAsk(await judge(ctx, ask, prompt, look))
      // Outside the step: a verdict journaled before a guard existed is held to it on replay too.
      return guardJudge(guardAsk(verdict, ask), given)
    },
  })
  return {
    workflow,
    summary:
      "Decide whether a lead's factory ask is the owner's or answerable from the repo, the plan or the declared default, with read-only tools over its checkout; the ask JSON comes on stdin",
    cli: { stdin: 'ask', defaultFormat: 'json', serverOnly: true },
    agents: [{ agent: ASK_AGENT, route: 'factory.ask' }],
  }
}
