import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { irisTriageScorer } from './scorer.ts'
import { IrisTriageInput, IrisTriageOutput } from './schema.ts'

const IRIS_TRIAGE_WORKFLOW_ID = 'iris-triage'
const IRIS_TRIAGE_VERSION = '2026-11-20.1'

/** The one capability the workflow calls; any registry that has `triage` fits. */
export type TriageCaller = Pick<HostRegistry, 'call'>

/**
 * `iris-triage`: the notification call Iris makes for a memo (`POST /triage`), replayed so `agw eval run --arm` can run the
 * `triage` route at another effort. One journaled step, the `triage` capability itself: the prompt, the schema check and
 * the re-ask are production's. Eval-only (`internal`): there is no command and no route; Iris keeps calling `agw triage`.
 */
export function createIrisTriage(deps: { registry: TriageCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: IRIS_TRIAGE_WORKFLOW_ID,
    version: IRIS_TRIAGE_VERSION,
    input: IrisTriageInput,
    output: IrisTriageOutput,
    scorer: irisTriageScorer,
    async run(ctx, input) {
      const { headline, detail, spoken, model, attempts, latencyMs } = (await ctx.step('triage', ({ callContext }) =>
        deps.registry.call('triage', input, callContext),
      )) as IrisTriageOutput
      return { headline, detail, spoken, model, attempts, latencyMs }
    },
  })
  return { workflow, internal: true }
}
