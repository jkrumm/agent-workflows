import {
  buildFactorySpecLookPrompt,
  guardSpecLook,
  SPEC_LOOK_SUBMIT_RETRY,
  specLookNonce,
  factorySpecLookOutput,
} from '@agent-workflows/capabilities'
import { type Ctx, defineWorkflow, type Json, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { lookOf } from '../factory-ask/index.ts'
import { factorySpecLookScorer } from './scorer.ts'
import { FactorySpecLookInput, FactorySpecLookOutput, type FactorySpecLookOutputValue } from './schema.ts'

const FACTORY_SPEC_LOOK_WORKFLOW_ID = 'factory-spec-look'
const FACTORY_SPEC_LOOK_VERSION = '2026-11-21.1'
const SPEC_LOOK_AGENT = 'factory-spec-look'

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/** One agent step and one retry with the `submit_result` directive; two invalid answers fail the run. */
async function look(ctx: Ctx, prompt: string, checkout: string | undefined): Promise<FactorySpecLookOutputValue> {
  // Read-only is the agent's own permissions (read, glob, grep: no shell, no edit, no network). No turn limit and no
  // wall-clock ceiling: the idle watchdog is the one stop.
  const options: Json = checkout === undefined ? { output: 'json' } : { output: 'json', allowDirectories: [checkout] }
  const spec = { agent: SPEC_LOOK_AGENT, output: factorySpecLookOutput, options }
  try {
    return await ctx.agent('look', { ...spec, prompt })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
  }
  return ctx.agent('look-retry', { ...spec, prompt: prompt + SPEC_LOOK_SUBMIT_RETRY })
}

/**
 * `factory-spec-look`: the Judge's one look at a gate's Spec before software-factory pages the owner: `ready` (he can read it
 * and give his verdict) or `back` (to its lead, with a note of what to sharpen). The Judge never gives a gate its verdict. An
 * agent step with read, glob and grep over the checkout the request names: it checks what the Spec says about the repo and
 * what the plan or the docs already settle. The answer is schema-checked and then held to `guardSpecLook`. It does not fail
 * closed: a failed look fails the run, because the factory then pages the owner as it did before there was a look.
 */
export function createFactorySpecLook(): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_SPEC_LOOK_WORKFLOW_ID,
    version: FACTORY_SPEC_LOOK_VERSION,
    input: FactorySpecLookInput,
    output: FactorySpecLookOutput,
    scorer: factorySpecLookScorer,
    async run(ctx, { request }) {
      // The same checkout rule as the Decision's Judge: a link that leaves it, or one that cannot be scanned, is not handed over.
      const where = await lookOf(ctx, request.checkout)
      const prompt = buildFactorySpecLookPrompt(request, specLookNonce(request), where)
      const answer = await look(ctx, prompt, 'checkout' in where ? where.checkout : undefined)
      // Outside the step: an answer journaled before a guard existed is held to it on replay too.
      return guardSpecLook(answer)
    },
  })
  return {
    workflow,
    summary:
      "Whether a gate's Spec is ready for the owner to read (ready) or goes back to its lead with a note of what to sharpen (back), with read-only tools over its checkout; the request JSON comes on stdin",
    cli: { stdin: 'request', defaultFormat: 'json', serverOnly: true },
    agents: [{ agent: SPEC_LOOK_AGENT, route: 'factory.speclook' }],
  }
}
