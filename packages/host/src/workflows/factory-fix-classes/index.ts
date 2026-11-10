import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryFixClassesInput, FactoryFixClassesOutput } from './schema.ts'

const FACTORY_FIX_CLASSES_WORKFLOW_ID = 'factory-fix-classes'
const FACTORY_FIX_CLASSES_VERSION = '2026-11-10.1'

/** The one capability the workflow calls; any registry that has `factory.fixclasses` fits. */
export type FixClassesCaller = Pick<HostRegistry, 'call'>

/**
 * `factory-fix-classes`: software-factory's Improve screen counts fix commits per week by class; the commits whose scope
 * and subject do not settle the class are sorted here. One journaled step, one tool-free `factory.fixclasses` call on its
 * route. The capability holds the answer to the request (one answer per sha, a class from the input), so the output is
 * exactly that or the run fails: a wrong answer is never repaired and a failed call is the factory's to retry.
 */
export function createFactoryFixClasses(deps: { registry: FixClassesCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_FIX_CLASSES_WORKFLOW_ID,
    version: FACTORY_FIX_CLASSES_VERSION,
    input: FactoryFixClassesInput,
    output: FactoryFixClassesOutput,
    async run(ctx, { request }) {
      return ctx.step('sort', ({ callContext }) => deps.registry.call('factory.fixclasses', { request }, callContext))
    },
  })
  return {
    workflow,
    summary: 'Sort fix commits into the classes the caller sends, one answer per sha; the request JSON comes on stdin',
    cli: { stdin: 'request', defaultFormat: 'json' },
  }
}
