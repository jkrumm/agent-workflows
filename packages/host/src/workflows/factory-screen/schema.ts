import { factoryScreenInput, factoryScreenOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactoryScreenInput = z.object({
  request: factoryScreenInput.describe(
    'The held signal with the open Issues of its repo and the known projects, piped on stdin as JSON',
  ),
})

/** The answer: promote, dismiss or leave; `repo` and `duplicateOf` are claims the guard and the factory re-check. */
export const FactoryScreenOutput = factoryScreenOutput
export type FactoryScreenOutputValue = z.output<typeof FactoryScreenOutput>
