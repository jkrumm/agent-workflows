import { factorySpecScreenInput, factorySpecScreenOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactorySpecScreenInput = z.object({
  request: factorySpecScreenInput.describe(
    'The Spec, its Issue and the owner’s marks on earlier Specs, piped on stdin as JSON',
  ),
})

/** The answer: pass or settle with a one-line reason; nothing else. */
export const FactorySpecScreenOutput = factorySpecScreenOutput
export type FactorySpecScreenOutputValue = z.output<typeof FactorySpecScreenOutput>
