import { factorySpecLookInput, factorySpecLookOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactorySpecLookInput = z.object({
  request: factorySpecLookInput.describe(
    "A gate's Spec, its Issue, the owner's marks on earlier Specs, the checkout to read and the case file, piped on stdin as JSON",
  ),
})

/** The answer: ready, or back with a note for the lead; never a verdict on the gate. */
export const FactorySpecLookOutput = factorySpecLookOutput
export type FactorySpecLookOutputValue = z.output<typeof FactorySpecLookOutput>
