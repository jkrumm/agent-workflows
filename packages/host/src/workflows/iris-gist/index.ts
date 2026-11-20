import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { irisGistScorer } from './scorer.ts'
import { IrisGistInput, IrisGistOutput } from './schema.ts'

export const IRIS_GIST_WORKFLOW_ID = 'iris-gist'
const IRIS_GIST_VERSION = '2026-11-20.1'

/** The one capability the workflow calls; any registry that has `llm.summarize` fits. */
export type SummarizeCaller = Pick<HostRegistry, 'call'>

/**
 * `iris-gist`: the transcript gist Iris asks for on a long memo (`POST /llm/summarize`, 30 words, a paragraph), replayed so
 * `agw eval run --arm` can run the `cheap.summarize` route at another effort. One journaled step, the `llm.summarize`
 * capability itself. Eval-only (`internal`): there is no command and no route.
 */
export function createIrisGist(deps: { registry: SummarizeCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: IRIS_GIST_WORKFLOW_ID,
    version: IRIS_GIST_VERSION,
    input: IrisGistInput,
    output: IrisGistOutput,
    scorer: irisGistScorer,
    async run(ctx, { text, maxWords }) {
      const { summary } = await ctx.step('summarize', ({ callContext }) =>
        deps.registry.call('llm.summarize', { text, maxWords, style: 'paragraph' }, callContext),
      )
      return { summary }
    },
  })
  return { workflow, internal: true }
}
