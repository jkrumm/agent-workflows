import { factoryFixClassesInput, factoryFixClassesOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the request is one property because the CLI reads exactly one property from stdin. */
export const FactoryFixClassesInput = z.object({
  request: factoryFixClassesInput.describe('The repo, the classes and 1 to 40 fix commits, piped on stdin as JSON'),
})

/** The answer: `{answers: [{sha, class, reason}]}`, one per input sha, each class one of the input's keys. */
export const FactoryFixClassesOutput = factoryFixClassesOutput
export type FactoryFixClassesOutputValue = z.output<typeof FactoryFixClassesOutput>
