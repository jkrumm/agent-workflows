import { factoryAskInput, factoryAskOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/**
 * The workflow's input. The ask is one property because the CLI reads exactly one property from stdin: the caller pipes
 * the ask object (`{question, options, default, facts, plan, repo}`) to `agw factory-ask`. Everything but `repo` is
 * untrusted data.
 */
export const FactoryAskInput = z.object({
  ask: factoryAskInput.describe("The lead's ask, piped on stdin as JSON"),
})

/** The answer: `answer` is one of `ask.options` when there are any; `owner` carries an empty answer and source. */
export const FactoryAskOutput = factoryAskOutput
export type FactoryAskOutputValue = z.output<typeof FactoryAskOutput>
