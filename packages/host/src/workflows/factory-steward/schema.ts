import { factoryStewardInput, factoryStewardOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the stall is one property because the CLI reads exactly one property from stdin. */
export const FactoryStewardInput = z.object({
  stall: factoryStewardInput.describe('The stalled Issue and its facts, piped on stdin as JSON'),
})

/** The answer: one action that ends the stall, or `none` when the steward cannot tell (the factory then raises a Decision of its own). */
export const FactoryStewardOutput = factoryStewardOutput
export type FactoryStewardOutputValue = z.output<typeof FactoryStewardOutput>
