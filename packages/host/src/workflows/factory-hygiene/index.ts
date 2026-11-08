import { Cancelled, defineWorkflow, InfraError, StepFailed, type Ctx } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { guardHygiene } from './guard.ts'
import { buildHygienePrompt, hygieneNonce, SUBMIT_RESULT_RETRY } from './prompt.ts'
import { findEscapingLink } from './scan.ts'
import {
  FactoryHygieneInput,
  FactoryHygieneOutput,
  type FactoryHygieneOutputValue,
  type HygieneInput,
  hygieneNone,
} from './schema.ts'

const FACTORY_HYGIENE_WORKFLOW_ID = 'factory-hygiene'
const FACTORY_HYGIENE_VERSION = '2026-11-08.1'
export const HYGIENE_AGENT = 'factory-hygiene'

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/** One agent step and one retry with a `submit_result` directive; two invalid answers fail the call (and so close). */
async function review(ctx: Ctx, input: HygieneInput): Promise<FactoryHygieneOutputValue> {
  const prompt = buildHygienePrompt(input, hygieneNonce(input))
  // `allowDirectories`: the agent works in its compiled location, so the checkout is an external directory. Read-only is the
  // agent's own permissions (read, glob, grep: no shell, no edit, no network); no wall-clock ceiling, the idle watchdog only.
  const spec = {
    agent: HYGIENE_AGENT,
    output: FactoryHygieneOutput,
    options: { output: 'json', allowDirectories: [input.cwd] },
  }
  try {
    return await ctx.agent('review', { ...spec, prompt })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
  }
  return ctx.agent('review-retry', { ...spec, prompt: prompt + SUBMIT_RESULT_RETRY })
}

/**
 * `factory-hygiene`: software-factory's hygiene loop sweeps each project weekly. The deterministic part stays in the factory;
 * this is the judgment that needs a model reading files: which living documents went stale against the code, and which
 * recently edited ones carry filler. One scan step (no link may leave the checkout), one agent step with read-only tools
 * over the request's `cwd`; the answer is schema-checked and held to `guardHygiene`. Fails closed to no findings instead of
 * failing the run.
 */
export function createFactoryHygiene(): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_HYGIENE_WORKFLOW_ID,
    version: FACTORY_HYGIENE_VERSION,
    input: FactoryHygieneInput,
    output: FactoryHygieneOutput,
    async run(ctx, { hygiene }) {
      try {
        const escape = await ctx.step('scan', async () => ({ link: await findEscapingLink(hygiene.cwd) }))
        if (escape.link !== null) return hygieneNone('hygiene unavailable: a link leaves the checkout')
        const answer = await review(ctx, hygiene)
        // Outside the step: an answer journaled before the guard existed is held to it on replay too.
        return guardHygiene(answer, hygiene)
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the answer.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return hygieneNone(`hygiene unavailable: ${error instanceof StepFailed ? error.stepKind : 'error'}`)
      }
    },
  })
  return {
    workflow,
    summary:
      'Find stale and filler documents in a read-only checkout, with read-only tools; the hygiene candidates JSON comes on stdin',
    cli: { stdin: 'hygiene', defaultFormat: 'json' },
    agents: [{ agent: HYGIENE_AGENT, route: 'factory.hygiene' }],
  }
}
