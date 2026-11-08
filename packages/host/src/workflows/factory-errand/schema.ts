import { factoryErrandInput, factoryErrandOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactoryErrandInput = z.object({
  request: factoryErrandInput.describe('The Errand with its Issue, piped on stdin as JSON'),
})

/** The answer: pass or turn_away with a one-line reason; nothing else. */
export const FactoryErrandOutput = factoryErrandOutput
export type FactoryErrandOutputValue = z.output<typeof FactoryErrandOutput>
