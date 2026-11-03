import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { PodcastInput, PodcastOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const PODCAST_SCORER_VERSION = '2026-11-03.1'

/**
 * What a careful reader expects of an episode about the case's brief: `anchors`, words of the brief of which the title,
 * description or a chapter title must carry at least one (a deterministic check that the episode is about the brief,
 * not a quality judgment).
 */
export const PodcastReference = z.strictObject({ anchors: z.array(z.string().min(1)).min(1) })
export type PodcastReference = z.output<typeof PodcastReference>

/**
 * The produced length as a share of the requested minutes. A first guess for short pinned episodes (`pinMinutes`):
 * calibrate on the first eval runs and bump the scorer version with it.
 */
export const DURATION_BAND = { min: 0.6, max: 1.5 } as const

/** Words of each language that the other lacks (`in`, `an`, `so`, `war`, `was`, `will` are in both and left out). */
const STOPWORDS = {
  de: 'der die das und ist nicht ein eine einer einem einen zu mit von für auf auch sich den dem des im wie aber oder wir sie es als wird werden bei nach aus über noch nur mehr wenn kann sind haben dass warum wer wann dieser diese dieses gibt zum zur um',
  en: 'the and is of to that it for with as on are this be by not or from at have but they you can we which what why how when who your about into their there these those been does just than',
} as const

type Lang = keyof typeof STOPWORDS
const SETS: Record<Lang, Set<string>> = {
  de: new Set(STOPWORDS.de.split(' ')),
  en: new Set(STOPWORDS.en.split(' ')),
}

/** The words of a text, lowercase, letters (umlauts included) and digits. */
export const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The least words a language call is made on, the share of stopwords the winner needs, and how far it must lead. */
const MIN_WORDS = 12
const MIN_SHARE = 0.12
const MIN_LEAD = 2

/**
 * `de` or `en` by the share of stopwords of each language among the words; null when the text is too short or neither
 * language clearly leads (a deterministic check, not a classifier).
 */
export function languageOf(text: string): Lang | null {
  const words = wordsOf(text)
  if (words.length < MIN_WORDS) return null
  const hits = (lang: Lang) => words.filter((w) => SETS[lang].has(w)).length
  const [de, en] = [hits('de'), hits('en')]
  const [winner, high, low] = de >= en ? (['de', de, en] as const) : (['en', en, de] as const)
  if (high / words.length < MIN_SHARE) return null
  return high >= low * MIN_LEAD ? winner : null
}

const SCORE_KEYS = ['valid', 'metadata', 'language', 'chapters', 'duration', 'cost', 'grounded'] as const

const sameUsd = (a: number, b: number) => Math.abs(a - b) <= 1e-6

/**
 * The `podcast` scorer. Deterministic, no model. Every score is 0 or 1; when `valid` is 0 so is every other score:
 * - `valid`: the output parses and the input is a podcast request;
 * - `metadata`: a title and a description, neither blank;
 * - `language`: title, description and chapter titles together are in the requested language, by stopword share;
 * - `chapters`: at least one, each with a title and a start time, the first at the start of the episode, the starts
 *   rising strictly and all inside the episode (so no two chapters overlap);
 * - `duration`: the produced length is within DURATION_BAND of the requested minutes;
 * - `cost`: the episode's total is above 0, the sum of its three parts, and complete (no unpriced call, no research
 *   run still going);
 * and with a reference `grounded`: the title, description or a chapter title holds one of the reference's anchors.
 * `pass`: every score 1. Without a reference (drift) `grounded` is left out.
 */
export const podcastScorer: Scorer<unknown, PodcastReference> = {
  version: PODCAST_SCORER_VERSION,
  reference: PodcastReference,
  score(input, output, ctx): Verdict {
    const keys = ctx.reference ? SCORE_KEYS : SCORE_KEYS.filter((k) => k !== 'grounded')
    const failed = (feedback: string): Verdict => ({
      scores: Object.fromEntries(keys.map((k) => [k, 0])),
      pass: false,
      feedback,
    })
    const parsed = PodcastOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a podcast result')
    const request = PodcastInput.safeParse(input)
    if (!request.success) return failed('the input is not a podcast request')
    const { title, description, chapters, cost, produce } = parsed.data
    const { language, minutes } = request.data

    const feedback: string[] = []
    const miss = (why: string) => feedback.push(why)

    const titled = title.trim().length > 0 && description.trim().length > 0
    if (!titled) miss('title or description is blank')

    const text = [title, description, ...chapters.map((c) => c.title)].join(' ')
    const detected = languageOf(text)
    if (detected !== language) miss(`text reads as ${detected ?? 'neither language'} (want ${language})`)

    const ordered = chaptersOrdered(chapters, produce?.durationSeconds ?? null, miss)

    const seconds = produce?.durationSeconds ?? null
    const inBand =
      seconds !== null && seconds >= minutes * 60 * DURATION_BAND.min && seconds <= minutes * 60 * DURATION_BAND.max
    if (!inBand) miss(`the episode is ${seconds === null ? 'unmeasured' : `${seconds} s`} (want about ${minutes} min)`)

    const recorded =
      cost.totalUsd > 0 && cost.complete && sameUsd(cost.totalUsd, cost.scriptUsd + cost.researchUsd + cost.produceUsd)
    if (!recorded) miss(`cost is not recorded whole (total $${cost.totalUsd}, complete ${cost.complete})`)

    const scores: Record<string, number> = {
      valid: 1,
      metadata: titled ? 1 : 0,
      language: detected === language ? 1 : 0,
      chapters: ordered ? 1 : 0,
      duration: inBand ? 1 : 0,
      cost: recorded ? 1 : 0,
    }
    if (ctx.reference) {
      const haystack = text.toLowerCase()
      const grounded = ctx.reference.anchors.some((a) => haystack.includes(a.toLowerCase()))
      scores.grounded = grounded ? 1 : 0
      if (!grounded) miss(`holds none of ${ctx.reference.anchors.join(', ')}`)
    }
    return {
      scores,
      pass: Object.values(scores).every((v) => v === 1),
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}

/** The first chapter starts with the episode (within a second), starts rise strictly and all lie before the end. */
function chaptersOrdered(
  chapters: { title: string; startMs?: number | undefined }[],
  durationSeconds: number | null,
  miss: (why: string) => void,
): boolean {
  if (chapters.length === 0) {
    miss('no chapters')
    return false
  }
  if (chapters.some((c) => c.title.trim().length === 0)) {
    miss('a chapter has no title')
    return false
  }
  const starts = chapters.map((c) => c.startMs)
  if (starts.some((s) => s === undefined)) {
    miss('a chapter has no start time (the produce stage did not run)')
    return false
  }
  const ms = starts as number[]
  let ok = true
  if ((ms[0] ?? 0) > 1000) {
    miss(`the first chapter starts at ${ms[0]} ms`)
    ok = false
  }
  if (ms.some((s, i) => s < 0 || (i > 0 && s <= (ms[i - 1] ?? 0)))) {
    miss('chapter starts do not rise strictly')
    ok = false
  }
  if (durationSeconds === null || ms.some((s) => s >= durationSeconds * 1000)) {
    miss('a chapter starts at or after the end of the episode')
    ok = false
  }
  return ok
}
