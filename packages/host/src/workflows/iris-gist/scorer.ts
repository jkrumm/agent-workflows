import type { Scorer, ScoreJudge, Verdict } from '@agent-workflows/runtime'
import { clean, excerpt, hasMarkup, IrisReference, mentionShare, sameLanguage, wordCount } from '../iris-eval.ts'
import { decideBooleans } from '../judge-decide.ts'
import { IrisGistInput, IrisGistOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
const IRIS_GIST_SCORER_VERSION = '2026-11-20.1'

/** Iris cuts a gist at this many characters (`GIST_MAX` in its `adapters/agw.ts`): a longer answer reaches the user cut off. */
const IRIS_GIST_MAX_CHARS = 240

const ZERO = { valid: 0, words: 0, fits: 0, plain: 0, language: 0, clean: 0, mentions: 0 }
/** An answer that opens by talking about the task, not the text. */
const PREAMBLE = /^(here('s| is)|summary:|zusammenfassung:|the (text|memo) (says|is about)|in summary|hier ist)/i

const QUESTIONS = {
  faithful: 'Every statement of the summary follows from the text: nothing is invented, changed or contradicted.',
  gist: 'The summary states the main point or request of the text, so a reader who skips the text knows what it was about.',
} as const

async function judge(judgeCall: ScoreJudge, text: string, summary: string) {
  const state = ['## Text', excerpt(text), '', '## Summary', summary].join('\n')
  const answers = await decideBooleans(judgeCall, state, QUESTIONS)
  return Object.fromEntries(Object.entries(answers).flatMap(([k, v]) => (v === null ? [] : [[k, v ? 1 : 0]])))
}

/**
 * The `iris-gist` scorer. Every score is 0 or 1 (`mentions` a share); when `valid` is 0 so is every other score:
 * - `valid`: the output parses as a non-empty summary;
 * - `words`: at most the input's `maxWords` words; `fits`: at most `IRIS_GIST_MAX_CHARS` characters (what Iris keeps);
 * - `plain`: one paragraph with no markup and no opening that talks about the task;
 * - `language`: in the text's language; `clean`, `mentions`: as in `iris-triage`;
 * - `faithful`, `gist` (when a judge is given): the `decide` judge's yes or no; a question it could not answer is left out.
 * `pass`: every score is 1.
 */
export const irisGistScorer: Scorer<unknown, IrisReference> = {
  version: IRIS_GIST_SCORER_VERSION,
  reference: IrisReference,
  async score(rawInput, output, ctx): Promise<Verdict> {
    const parsed = IrisGistOutput.safeParse(output)
    const request = IrisGistInput.safeParse(rawInput)
    if (!parsed.success || !request.success || parsed.data.summary.trim() === '') {
      return {
        scores: { ...ZERO },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not a summary',
      }
    }
    const summary = parsed.data.summary.trim()
    const { text, maxWords } = request.data
    const want = ctx.reference ?? { mustMention: [], forbid: [] }
    const feedback: string[] = []

    const scores: Record<string, number> = {
      valid: 1,
      words: wordCount(summary) <= maxWords ? 1 : 0,
      fits: summary.length <= IRIS_GIST_MAX_CHARS ? 1 : 0,
      plain: !summary.includes('\n') && !hasMarkup(summary) && !PREAMBLE.test(summary) ? 1 : 0,
      language: sameLanguage(text, summary),
      clean: clean(summary, want.forbid),
      mentions: mentionShare(summary, want.mustMention),
    }
    if (!scores.words) feedback.push(`${wordCount(summary)} words (bound ${maxWords})`)
    if (!scores.fits) feedback.push(`${summary.length} characters: Iris cuts at ${IRIS_GIST_MAX_CHARS}`)
    if (!scores.plain) feedback.push('more than one line, markup, or an opening about the task')
    if (!scores.language) feedback.push('not in the text language')

    const judged = ctx.judge ? await judge(ctx.judge, text, summary) : {}
    for (const [key, question] of Object.entries(QUESTIONS)) {
      const score = judged[key]
      if (score === undefined) continue
      scores[key] = score
      if (score === 0) feedback.push(`judge: not ${key}: ${question}`)
    }
    return {
      scores,
      pass: Object.values(scores).every((v) => v === 1),
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}
