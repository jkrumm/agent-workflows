import { factoryAskOutput, factoryJudgeInput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/**
 * The workflow's input. The Decision is one property because the CLI reads exactly one property from stdin: the caller pipes
 * software-factory's Decision to `agw factory-ask` (`{decision, repo, issue, question, recommendation, checked,
 * options[{label, reversible, cost}], noAnswer, precedents[]}`). Everything but `repo` and the Decision id is untrusted data.
 */
export const FactoryAskInput = z.object({
  ask: factoryJudgeInput.describe("The factory's Decision, piped on stdin as JSON"),
})

/** The answer: `answer` is one of the options' labels; `owner` carries an empty answer and source. */
export const FactoryAskOutput = factoryAskOutput
export type FactoryAskOutputValue = z.output<typeof FactoryAskOutput>
