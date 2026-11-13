import { factoryErrandNeededInput, factoryErrandNeededOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactoryErrandNeededInput = z.object({
  request: factoryErrandNeededInput.describe('The open request with the evidence about it, piped on stdin as JSON'),
})

/** The answer: needed, not_needed or unsure with a one-line reason; nothing else. */
export const FactoryErrandNeededOutput = factoryErrandNeededOutput
export type FactoryErrandNeededOutputValue = z.output<typeof FactoryErrandNeededOutput>
