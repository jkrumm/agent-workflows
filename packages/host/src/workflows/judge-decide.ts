import type { ScoreJudge } from '@agent-workflows/runtime'
import { asRecord } from './research/util.ts'

/** The decision API reads at most this many characters of state; a judged score keeps clear of it. */
export const JUDGE_STATE_CHARS = 40_000

/**
 * Boolean questions put to the `decide` judge (the IU decision API, input-priced: about $0.00002 for a spec-sized state),
 * as drift and regression scorers use it for a judged score. One call, any number of questions over the same state.
 * A question the judge could not answer (an answer failure, no boolean) is `null`: unscored, never `false`. An outage
 * throws, and the runtime retries the scoring.
 */
export async function decideBooleans(
  judge: ScoreJudge,
  state: string,
  questions: Record<string, string>,
): Promise<Record<string, boolean | null>> {
  const ids = Object.keys(questions)
  const asked = Object.fromEntries(
    Object.entries(questions).map(([id, text]) => [id, { type: 'boolean', instructions: text }]),
  )
  const decided = asRecord(await judge('decide', { state: state.slice(0, JUDGE_STATE_CHARS), questions: asked }))
  const answers = decided.error === undefined ? asRecord(decided.answers) : {}
  return Object.fromEntries(
    ids.map((id) => {
      const value = asRecord(answers[id]).value
      return [id, typeof value === 'boolean' ? value : null]
    }),
  )
}

/** The mean of the answers that came back; `null` when none did (the score is left out, not 0). */
export function shareTrue(answers: (boolean | null)[]): number | null {
  const given = answers.filter((a): a is boolean => a !== null)
  return given.length === 0 ? null : given.filter(Boolean).length / given.length
}
