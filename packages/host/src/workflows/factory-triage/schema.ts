import { factoryTriageInput, factoryTriageOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactoryTriageInput = z.object({
  request: factoryTriageInput.describe(
    'The signal to match or the Issue to chain, with the open Issues it may name, piped on stdin as JSON',
  ),
})

/** The answer: the Issue to amend (mode amend), or the Issues to wait for, a kind and a size (mode settle). Only Issues the request showed. */
export const FactoryTriageOutput = factoryTriageOutput
export type FactoryTriageOutputValue = z.output<typeof FactoryTriageOutput>
