import { floorIncident } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { factoryClassifyScorer } from './scorer.ts'
import { FactoryClassifyInput, FactoryClassifyOutput } from './schema.ts'

export const FACTORY_CLASSIFY_WORKFLOW_ID = 'factory-classify'
export const FACTORY_CLASSIFY_VERSION = '2026-11-02.1'

/** The one capability the workflow calls; any registry that has `factory.classify` fits. */
export type ClassifyCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-classify`: software-factory's Classify station. One journaled step, one tool-free `factory.classify` call
 * on its route; the answer is the schema-checked verdict. The Issue text is fenced as data inside the capability, and
 * the journal keeps the step's result, so a resumed run reads it back and never asks twice.
 */
export function createFactoryClassify(deps: { registry: ClassifyCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_CLASSIFY_WORKFLOW_ID,
    version: FACTORY_CLASSIFY_VERSION,
    input: FactoryClassifyInput,
    output: FactoryClassifyOutput,
    scorer: factoryClassifyScorer,
    async run(ctx, { issue }) {
      const verdict = await ctx.step('classify', ({ callContext }) =>
        deps.registry.call('factory.classify', issue, callContext),
      )
      // Outside the step: a verdict journaled before the floor existed is floored on replay too.
      return floorIncident(verdict)
    },
  })
  return {
    workflow,
    summary: 'Classify a factory Issue: project, kind, class, size, tier and effort; the Issue JSON comes on stdin',
    cli: { stdin: 'issue', defaultFormat: 'json' },
  }
}
