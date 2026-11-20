import type { Scorer, ScoreJudge, Verdict } from '@agent-workflows/runtime'
import { decideBooleans } from '../judge-decide.ts'
import { clean, excerpt, hasMarkup, IrisReference, mentionShare, sameLanguage, sentenceCount } from '../iris-eval.ts'
import { IrisTriageInput, IrisTriageOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
const IRIS_TRIAGE_SCORER_VERSION = '2026-11-20.1'

const ZERO = { valid: 0, language: 0, spoken: 0, clean: 0, mentions: 0 }
/** The prompt asks for "at most two short sentences". */
const SPOKEN_SENTENCES = 2

const QUESTIONS = {
  faithful:
    'Every statement in the notification (headline, detail, spoken) follows from the transcript and the assistant reply: nothing is invented, changed or contradicted.',
  headline: 'The headline names what the memo was about, so a reader who sees only the headline knows the topic.',
  detail:
    'The detail says what was done or answered: it matches the assistant reply, or, when there is no reply, what the memo asks or says.',
  spoken: 'The spoken line is a natural, correct, short statement of the same outcome as the detail.',
} as const

async function judge(judgeCall: ScoreJudge, input: IrisTriageInput, out: IrisTriageOutput) {
  const state = [
    '## Transcript of a dictated voice memo',
    excerpt(input.transcript),
    '',
    '## Assistant reply',
    input.reply ? excerpt(input.reply) : '(none)',
    '',
    '## Notification',
    `Headline: ${out.headline}`,
    `Detail: ${out.detail}`,
    `Spoken: ${out.spoken}`,
  ].join('\n')
  const answers = await decideBooleans(judgeCall, state, QUESTIONS)
  return Object.fromEntries(Object.entries(answers).flatMap(([k, v]) => (v === null ? [] : [[k, v ? 1 : 0]])))
}

/**
 * The `iris-triage` scorer. Every score is 0 or 1 (`mentions` a share); when `valid` is 0 so is every other score:
 * - `valid`: the output parses as the notification and the input as Iris's call;
 * - `language`: the three fields are in the memo's language (German or English by stopwords; 1 when a text is too short to tell);
 * - `spoken`: at most two sentences and no markup a voice would read out;
 * - `clean`, `mentions` (reference `forbid`, `mustMention`): no forbidden string anywhere; the share of terms found;
 * - `faithful`, `headline`, `detail`, `spokenOk` (when a judge is given): the `decide` judge's yes or no on each question in
 *   `QUESTIONS`; a question it could not answer is left out, never a 0;
 * - `oneCall`: 1 when the answer came on the first call (a re-ask doubles the latency); reported, not gated.
 * `pass`: every score but `oneCall` is 1. A reference is optional: mined cases carry none.
 */
export const irisTriageScorer: Scorer<unknown, IrisReference> = {
  version: IRIS_TRIAGE_SCORER_VERSION,
  reference: IrisReference,
  async score(rawInput, output, ctx): Promise<Verdict> {
    const parsed = IrisTriageOutput.safeParse(output)
    const request = IrisTriageInput.safeParse(rawInput)
    if (!parsed.success || !request.success) {
      return {
        scores: { ...ZERO },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not a notification',
      }
    }
    const out = parsed.data
    const all = `${out.headline}\n${out.detail}\n${out.spoken}`
    const want = ctx.reference ?? { mustMention: [], forbid: [] }
    const feedback: string[] = []

    const language = sameLanguage(request.data.transcript, all)
    if (!language) feedback.push('the notification is not in the memo language')
    const spoken = sentenceCount(out.spoken) <= SPOKEN_SENTENCES && !hasMarkup(out.spoken) ? 1 : 0
    if (!spoken) feedback.push('the spoken line is longer than two sentences or holds markup')
    const scores: Record<string, number> = {
      valid: 1,
      language,
      spoken,
      clean: clean(all, want.forbid),
      mentions: mentionShare(all, want.mustMention),
    }
    if (!scores.clean) feedback.push('the notification holds a forbidden string')
    if ((scores.mentions ?? 1) < 1) feedback.push('the notification lacks a required term')

    const judged = ctx.judge ? await judge(ctx.judge, request.data, out) : {}
    for (const [key, question] of Object.entries(QUESTIONS)) {
      const score = judged[key]
      if (score === undefined) continue
      scores[key === 'spoken' ? 'spokenOk' : key] = score
      if (score === 0) feedback.push(`judge: not ${key}: ${question}`)
    }
    const oneCall = out.attempts === 1 ? 1 : 0
    return {
      scores: { ...scores, oneCall },
      pass: Object.values(scores).every((v) => v === 1),
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}
