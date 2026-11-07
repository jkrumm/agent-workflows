import { guardTriage, triageNone } from '@agent-workflows/capabilities'
import { Cancelled, defineWorkflow, InfraError, StepFailed } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryTriageInput, FactoryTriageOutput } from './schema.ts'

const FACTORY_TRIAGE_WORKFLOW_ID = 'factory-triage'
const FACTORY_TRIAGE_VERSION = '2026-11-07.1'

/** The one capability the workflow calls; any registry that has `factory.triage` fits. */
export type TriageCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-triage`: software-factory's triage asks, when deterministic matching is unsure, whether a signal amends an open
 * Issue (mode `amend`), and which open Issues a new Issue must wait for (mode `settle`). One journaled step, one tool-free
 * `factory.triage` call on its route; the answer is schema-checked and then held to `guardTriage`: only Issues the request
 * showed. Fails closed to the empty answer (file anew, no edges) instead of failing the run.
 */
export function createFactoryTriage(deps: { registry: TriageCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_TRIAGE_WORKFLOW_ID,
    version: FACTORY_TRIAGE_VERSION,
    input: FactoryTriageInput,
    output: FactoryTriageOutput,
    async run(ctx, { request }) {
      try {
        const answer = await ctx.step('triage', ({ callContext }) =>
          deps.registry.call('factory.triage', { request }, callContext),
        )
        // Outside the step: an answer journaled before the guard existed is held to it on replay too.
        return guardTriage(answer, request)
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the answer.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return triageNone(`triage unavailable: ${error instanceof StepFailed ? error.stepKind : 'error'}`)
      }
    },
  })
  return {
    workflow,
    summary:
      'Match a signal to an open Issue, or name the open Issues a new Issue must wait for; the request JSON comes on stdin',
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
