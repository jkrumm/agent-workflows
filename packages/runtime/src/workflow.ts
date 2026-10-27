import type { z } from 'zod'
import type { Workflow, WorkflowDefinition } from './types.ts'

export function defineWorkflow<I extends z.ZodType, O extends z.ZodType>(
  definition: WorkflowDefinition<I, O>,
): Workflow<I, O> {
  if (!definition.id) throw new Error('defineWorkflow: id is required')
  if (!definition.version) throw new Error(`defineWorkflow(${definition.id}): version is required`)
  const { concurrency } = definition
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new Error(`defineWorkflow(${definition.id}): concurrency must be a positive integer`)
  }
  return Object.freeze({ ...definition })
}
