import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { SpeechRoundtripInput, SpeechRoundtripOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const SPEECH_SCORER_VERSION = '2026-11-03.1'

/** What a case allows: the word error rate (0..1) at most, for a sentence the transcript may spell its own way. */
export const SpeechReference = z.strictObject({ maxWer: z.number().min(0).max(1) })
export type SpeechReference = z.output<typeof SpeechReference>

/** Without a reference: a clean read-back of a short sentence is under 15 % off. */
export const DEFAULT_MAX_WER = 0.15

/** Seconds of audio per spoken word: natural speech is ~0.4 s (150 words a minute); outside this band it is clipped or dragging. */
export const PACE_BAND = { min: 0.2, max: 0.8 } as const

type Language = 'de' | 'en'

const EN_UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 0..9999 as English words ("1234": one thousand two hundred thirty four), without "and". */
function englishWords(n: number): string[] {
  if (n < 20) return [EN_UNITS[n] ?? '']
  if (n < 100) return [EN_TENS[Math.floor(n / 10)] ?? '', ...(n % 10 ? [EN_UNITS[n % 10] ?? ''] : [])]
  if (n < 1000) return [...englishWords(Math.floor(n / 100)), 'hundred', ...(n % 100 ? englishWords(n % 100) : [])]
  return [...englishWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? englishWords(n % 1000) : [])]
}

const DE_UNITS = [
  'null',
  'eins',
  'zwei',
  'drei',
  'vier',
  'fünf',
  'sechs',
  'sieben',
  'acht',
  'neun',
  'zehn',
  'elf',
  'zwölf',
  'dreizehn',
  'vierzehn',
  'fünfzehn',
  'sechzehn',
  'siebzehn',
  'achtzehn',
  'neunzehn',
]
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig']

/** 0..99 as one German word ("23": dreiundzwanzig); larger numbers stay digits and are compared as written. */
function germanWord(n: number): string[] {
  if (n < 20) return [DE_UNITS[n] ?? '']
  const [tens, unit] = [DE_TENS[Math.floor(n / 10)] ?? '', n % 10]
  if (unit === 0) return [tens]
  return [`${unit === 1 ? 'ein' : (DE_UNITS[unit] ?? '')}und${tens}`]
}

/** A run of digits as the words a speaker says; digits that no table covers are left as they are. */
function numberWords(digits: string, language: Language): string[] {
  const n = Number(digits)
  if (digits.length > 4 || (digits.length > 1 && digits.startsWith('0'))) return [digits]
  if (language === 'en') return englishWords(n)
  return n < 100 ? germanWord(n) : [digits]
}

/**
 * The words of a text as they are compared: lowercase, apostrophes dropped (so "don't" is "dont"), hyphens and
 * punctuation as separators, and every ASCII number written out (English up to 9999, German up to 99), so "23" and
 * "twenty-three" are the same words and "7:45" is "seven forty five". Digits beyond the tables stay digits.
 */
export function normalizeWords(text: string, language: Language): string[] {
  const plain = text.normalize('NFC').toLowerCase().replace(/['’`]/g, '')
  // ASCII digit runs are numbers; any other numeral (fullwidth, superscript, fractions) is a word as written.
  const tokens = plain.match(/\p{L}+|[0-9]+|\p{N}+/gu) ?? []
  return tokens.flatMap((token) => (/^[0-9]+$/.test(token) ? numberWords(token, language) : [token]))
}

/** Edits (substitutions, deletions, insertions) turning `hypothesis` into `reference`, by word. */
export function editDistance(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, j) => j)
  for (let i = 1; i <= reference.length; i++) {
    const row = [i]
    for (let j = 1; j <= hypothesis.length; j++) {
      const same = reference[i - 1] === hypothesis[j - 1]
      row[j] = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (same ? 0 : 1))
    }
    previous = row
  }
  return previous[hypothesis.length] ?? 0
}

/** Word error rate of `hypothesis` against `reference` after normalization: edits over the reference's words. */
export function wordErrorRate(
  reference: string,
  hypothesis: string,
  language: Language,
): { wer: number; edits: number; words: number } {
  const [ref, hyp] = [normalizeWords(reference, language), normalizeWords(hypothesis, language)]
  const edits = editDistance(ref, hyp)
  return { wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : edits / ref.length, edits, words: ref.length }
}

const GATES = ['valid', 'werOk', 'pace', 'recorded'] as const

/**
 * The `speech-roundtrip` scorer. Deterministic, no model. A sentence went through a TTS route and the audio through an
 * STT route; the score is how much of the sentence came back and how it sounded:
 * - `wer`: word error rate of the transcript against the sentence, after normalization (case, punctuation, apostrophes,
 *   numbers as words), in 0..1 (clipped), lower is better; reported, with `secondsPerWord`, so arms compare on them;
 * - `werOk`: `wer` at most the case's `maxWer` (default ${DEFAULT_MAX_WER});
 * - `pace`: audio seconds per sentence word within PACE_BAND;
 * - `recorded`: both calls are on the record: at least one priced call each, no call without a price;
 * - `valid`: the output parses and the sentence has words.
 * `pass`: every gate 1. When `valid` is 0 so is every gate and `wer` is 1.
 */
export const speechRoundtripScorer: Scorer<unknown, SpeechReference> = {
  version: SPEECH_SCORER_VERSION,
  reference: SpeechReference,
  score(input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({
      scores: { ...Object.fromEntries(GATES.map((k) => [k, 0])), wer: 1, secondsPerWord: 0 },
      pass: false,
      feedback,
    })
    const parsed = SpeechRoundtripOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a round trip')
    const request = SpeechRoundtripInput.safeParse(input)
    if (!request.success) return failed('the input is not a round-trip request')
    const { text: sentence, language } = request.data
    const { text: heard, audioSeconds, tts, stt } = parsed.data

    const { wer, edits, words } = wordErrorRate(sentence, heard, language)
    if (words === 0) return failed('the sentence has no words')
    const maxWer = ctx.reference?.maxWer ?? DEFAULT_MAX_WER
    const secondsPerWord = audioSeconds / words

    const feedback: string[] = []
    const werOk = wer <= maxWer
    if (!werOk)
      feedback.push(`WER ${wer.toFixed(2)} (${edits} edits in ${words} words) over ${maxWer}: heard "${heard}"`)
    const pace = secondsPerWord >= PACE_BAND.min && secondsPerWord <= PACE_BAND.max
    if (!pace) feedback.push(`${audioSeconds} s for ${words} words is ${secondsPerWord.toFixed(2)} s a word`)
    const known = (leg: { calls: number; unpricedCalls: number; costUsd: number | null }) =>
      leg.calls >= 1 && leg.unpricedCalls === 0 && leg.costUsd !== null
    const recorded = known(tts) && known(stt)
    if (!recorded) feedback.push('a call is missing from the record or has no price')

    const scores = {
      valid: 1,
      werOk: werOk ? 1 : 0,
      pace: pace ? 1 : 0,
      recorded: recorded ? 1 : 0,
      wer: Math.min(1, wer),
      secondsPerWord,
    }
    return {
      scores,
      pass: GATES.every((k) => scores[k] === 1),
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}
