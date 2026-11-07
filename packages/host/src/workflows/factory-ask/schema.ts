import { factoryAskOrJudgeInput, factoryAskOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/**
 * The workflow's input. The ask is one property because the CLI reads exactly one property from stdin: the caller pipes
 * the ask object to `agw factory-ask`. Two shapes are taken: today's ask (`{question, options[], default, facts, plan,
 * repo}`, which the running factory sends for every repo) and the new core's Decision (`{decision, repo, issue, question,
 * recommendation, checked, options[{label, reversible, cost}], noAnswer, precedents[]}`). Everything but `repo` and the
 * Decision id is untrusted data.
 */
export const FactoryAskInput = z.object({
  ask: factoryAskOrJudgeInput.describe("The lead's ask or the factory's Decision, piped on stdin as JSON"),
})

/** The answer: `answer` is one of the options (their labels, for a Decision) when there are any; `owner` carries an empty answer and source. */
export const FactoryAskOutput = factoryAskOutput
export type FactoryAskOutputValue = z.output<typeof FactoryAskOutput>
