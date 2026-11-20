import { describe, expect, test } from 'bun:test'
import type { ScoreJudge } from '@agent-workflows/runtime'
import { irisCases } from '../src/eval-mine-iris.ts'
import { hasMarkup, languageOf, sameLanguage, sentenceCount, wordCount } from '../src/workflows/iris-eval.ts'
import { irisGistScorer } from '../src/workflows/iris-gist/scorer.ts'
import gistModule from '../src/workflows/iris-gist/module.ts'
import { irisTriageScorer } from '../src/workflows/iris-triage/scorer.ts'
import triageModule from '../src/workflows/iris-triage/module.ts'

const signal = new AbortController().signal
const score = (
  scorer: { score: (...a: never[]) => unknown },
  input: unknown,
  output: unknown,
  judge?: ScoreJudge,
  reference?: unknown,
) =>
  scorer.score(
    input as never,
    output as never,
    { source: 'regression', judge, reference, signal } as never,
  ) as Promise<{
    scores: Record<string, number>
    pass: boolean
    feedback?: string
  }>

/** A judge that answers every question with `answer`, or leaves the ones in `unknown` unanswered. */
const judgeSaying =
  (answer: boolean, unknown: string[] = []): ScoreJudge =>
  async (_capability, input) => {
    const questions = (input as { questions: Record<string, unknown> }).questions
    return {
      answers: Object.fromEntries(
        Object.keys(questions)
          .filter((id) => !unknown.includes(id))
          .map((id) => [id, { value: answer }]),
      ),
    }
  }

describe('the shared checks', () => {
  test('language: German and English by stopwords, null when too short or tied', () => {
    expect(languageOf('Bitte prüf mal, ob der Deploy auf dem Server noch läuft und ist grün.')).toBe('de')
    expect(languageOf('Please check that the deploy is green and that it has not failed.')).toBe('en')
    expect(languageOf('Deploy grün')).toBeNull()
    expect(
      sameLanguage('Bitte prüf mal, ob der Deploy noch läuft und ist grün.', 'The deploy is green and it has run.'),
    ).toBe(0)
    expect(sameLanguage('Bitte prüf mal, ob der Deploy noch läuft und ist grün.', 'Deploy 4711')).toBe(1)
  })

  test('sentences, words and markup', () => {
    expect(sentenceCount('Der Deploy ist grün. Alles läuft.')).toBe(2)
    expect(sentenceCount('Version 2.7.3 ist live')).toBe(0)
    expect(sentenceCount('Er braucht 3.5 Stunden. Dann ist er fertig!')).toBe(2)
    expect(wordCount('  eins zwei  drei ')).toBe(3)
    expect(hasMarkup('- ein Punkt')).toBe(true)
    expect(hasMarkup('Das ist **wichtig**')).toBe(true)
    expect(hasMarkup('Ein ganz normaler Satz.')).toBe(false)
  })
})

const memo = {
  destination: 'hermes',
  transcript: 'Bitte prüf mal, ob der Deploy auf dem Server noch läuft und ob die Tests grün sind.',
  reply: 'Der Deploy läuft, alle Tests sind grün.',
}
const note = {
  headline: 'Deploy geprüft',
  detail: 'Der Deploy läuft und die Tests sind grün.',
  spoken: 'Der Deploy läuft. Alle Tests sind grün.',
  model: 'm',
  attempts: 1,
  latencyMs: 1000,
}

describe('iris-triage scorer', () => {
  test('a good notification with a yes-judge passes with every score 1', async () => {
    const verdict = await score(irisTriageScorer, memo, note, judgeSaying(true))
    expect(verdict.pass).toBe(true)
    expect(verdict.scores).toEqual({
      valid: 1,
      language: 1,
      spoken: 1,
      clean: 1,
      mentions: 1,
      faithful: 1,
      headline: 1,
      detail: 1,
      spokenOk: 1,
      oneCall: 1,
    })
  })

  test('no judge: the judged scores are absent, not zero', async () => {
    const verdict = await score(irisTriageScorer, memo, note)
    expect(verdict.pass).toBe(true)
    expect(Object.keys(verdict.scores)).not.toContain('faithful')
  })

  test('a question the judge could not answer is left out; a no fails the case with the question named', async () => {
    const unanswered = await score(irisTriageScorer, memo, note, judgeSaying(true, ['detail']))
    expect(Object.keys(unanswered.scores)).not.toContain('detail')
    const no = await score(irisTriageScorer, memo, note, judgeSaying(false))
    expect(no.pass).toBe(false)
    expect(no.scores).toMatchObject({ faithful: 0, headline: 0, detail: 0, spokenOk: 0 })
    expect(no.feedback).toContain('not faithful')
  })

  test('an English answer to a German memo, a three-sentence spoken line and a re-ask each show', async () => {
    const english = await score(irisTriageScorer, memo, {
      ...note,
      headline: 'Deploy checked',
      detail: 'The deploy is running and all the tests are green.',
      spoken: 'The deploy is up.',
    })
    expect(english.scores.language).toBe(0)
    const long = await score(irisTriageScorer, memo, { ...note, spoken: 'Eins ist da. Zwei ist da. Drei ist da.' })
    expect(long.scores.spoken).toBe(0)
    const reasked = await score(irisTriageScorer, memo, { ...note, attempts: 2 })
    expect(reasked.scores.oneCall).toBe(0)
    expect(reasked.pass).toBe(true)
  })

  test('a reference: required terms and forbidden strings', async () => {
    const verdict = await score(irisTriageScorer, memo, note, undefined, {
      mustMention: ['deploy', 'rollback'],
      forbid: ['kaputt'],
    })
    expect(verdict.scores).toMatchObject({ mentions: 0.5, clean: 1 })
    expect(verdict.pass).toBe(false)
  })

  test('a failed run and a malformed output score zero', async () => {
    expect((await score(irisTriageScorer, memo, null)).feedback).toBe('the run failed')
    const bad = await score(irisTriageScorer, memo, { headline: 1 })
    expect(bad).toMatchObject({ pass: false, scores: { valid: 0 } })
  })
})

const text =
  'Ich wollte heute noch einmal über den Umzug der Datenbank sprechen, weil wir das nicht mehr lange aufschieben können.'
describe('iris-gist scorer', () => {
  const input = { text, maxWords: 30 }
  test('a one-line German gist passes', async () => {
    const verdict = await score(
      irisGistScorer,
      input,
      { summary: 'Der Umzug der Datenbank soll nicht länger aufgeschoben werden.' },
      judgeSaying(true),
    )
    expect(verdict.pass).toBe(true)
    expect(verdict.scores).toMatchObject({ valid: 1, words: 1, fits: 1, plain: 1, language: 1, faithful: 1, gist: 1 })
  })

  test("too many words, past Iris's cut, a bullet, a preamble and the wrong language each show", async () => {
    const long = Array.from({ length: 40 }, () => 'wort').join(' ')
    expect(await score(irisGistScorer, input, { summary: long }).then((v) => v.scores)).toMatchObject({
      words: 0,
      fits: 1,
    })
    const wide = 'x'.repeat(241)
    expect(await score(irisGistScorer, input, { summary: wide }).then((v) => v.scores.fits)).toBe(0)
    expect(await score(irisGistScorer, input, { summary: '- Umzug der Datenbank' }).then((v) => v.scores.plain)).toBe(0)
    expect(
      await score(irisGistScorer, input, { summary: 'Here is the summary of the database move.' }).then(
        (v) => v.scores.plain,
      ),
    ).toBe(0)
    expect(
      await score(irisGistScorer, input, { summary: 'The database move should not be postponed for long.' }).then(
        (v) => v.scores.language,
      ),
    ).toBe(0)
  })

  test('an empty or missing summary scores zero', async () => {
    expect(await score(irisGistScorer, input, { summary: '  ' }).then((v) => v.pass)).toBe(false)
    expect(await score(irisGistScorer, input, null).then((v) => v.feedback)).toBe('the run failed')
  })
})

describe('the suites read their cases from the private eval dir', () => {
  test('plain suites: the cases are not in the repo', () => {
    expect(triageModule.suite).toBe('plain')
    expect(gistModule.suite).toBe('plain')
  })
})

describe('irisCases', () => {
  const run = (workflow: string, n: number, input: object) => ({
    workflow,
    inputHash: `hash${String(n).padStart(4, '0')}`,
    input,
  })
  const triage = (n: number, destination: string) =>
    run('cap.triage', n, { destination, transcript: `t${n}`, reply: destination === 'hermes' ? `r${n}` : null })

  test('every transcribe-only memo up to the cap, filled with replied ones spread over the history; one case per input', () => {
    const runs = [
      ...Array.from({ length: 6 }, (_, i) => triage(i, 'transcript only, not sent to an assistant')),
      ...Array.from({ length: 100 }, (_, i) => triage(100 + i, 'hermes')),
      triage(0, 'transcript only, not sent to an assistant'),
    ]
    const { 'iris-triage': cases } = irisCases(runs, { triage: 20, maxTranscribe: 14 })
    expect(cases).toHaveLength(20)
    const transcribed = cases.filter((c) => (c.input as { reply: unknown }).reply === null)
    expect(transcribed).toHaveLength(6)
    expect(new Set(cases.map((c) => c.id)).size).toBe(20)
    const replied = cases
      .filter((c) => (c.input as { reply: unknown }).reply !== null)
      .map((c) => (c.input as { transcript: string }).transcript)
    expect(replied).toContain('t100')
    expect(replied.at(-1)).not.toBe('t114')
    expect(cases[0]).toMatchObject({ reference: {} })
    expect(cases.map((c) => c.id).every((id) => id.startsWith('iris-triage-'))).toBe(true)
  })

  test('gist cases keep the recorded word bound, and an input that does not parse is skipped', () => {
    const { 'iris-gist': gist, 'iris-triage': triaged } = irisCases([
      run('cap.llm.summarize', 1, { text: 'a long transcript', maxWords: 30, style: 'paragraph' }),
      run('cap.llm.summarize', 2, { nope: true }),
      run('cap.triage', 3, { nope: true }),
    ])
    expect(gist).toHaveLength(1)
    expect(gist[0]?.input).toEqual({ text: 'a long transcript', maxWords: 30 })
    expect(triaged).toHaveLength(0)
  })
})
