import { z } from 'zod'
import { lower, mentions } from './scorer-text.ts'

// What the two Iris suites (`iris-triage`, `iris-gist`) share: the reference, the language and shape checks of a
// notification text, and the judge's question block. Every check is deterministic except the judge's, which a run with
// no judge leaves out (never a 0).

/**
 * What a reader of the memo expects beyond the generic checks. Cases mined from real memos carry none (`{}`): the
 * generic checks and the judge are the whole score. A hand-written case may name `mustMention` terms (`a|b` accepts
 * either) and `forbid` strings no part of the answer may hold.
 */
export const IrisReference = z.object({
  mustMention: z.array(z.string().min(1)).default([]),
  forbid: z.array(z.string().min(1)).default([]),
})
export type IrisReference = z.output<typeof IrisReference>

// Ambiguous words (`in`, `an`, `so`, `was`, `will`, `die`) are left out: the memos are German or English, nothing else.
const DE = new Set(
  'der das und ist nicht ich ein eine zu den mit auf für von dem es sich auch wir du wie dass im bitte mal noch nur aber oder wenn habe hat wird sind war kann einen als bei nach dann schon mir mich uns dir ob jetzt heute gerade'.split(
    ' ',
  ),
)
const EN = new Set(
  'the and is not i a to of for on with that it this we you are be have has can as at by from but or if just my me our there then now today'.split(
    ' ',
  ),
)
/** Fewer stopwords than this and the text is too short to name a language. */
const MIN_EVIDENCE = 3

/** `de` or `en` by stopword counts, `null` when the text is too short or the counts tie. */
export function languageOf(text: string): 'de' | 'en' | null {
  let de = 0
  let en = 0
  for (const word of lower(text).match(/\p{L}+/gu) ?? []) {
    if (DE.has(word)) de += 1
    if (EN.has(word)) en += 1
  }
  if (de + en < MIN_EVIDENCE || de === en) return null
  return de > en ? 'de' : 'en'
}

/** 1 when the answer is in the memo's language, or when either text names none (a short memo, a name, a number). */
export function sameLanguage(memo: string, answer: string): number {
  const want = languageOf(memo)
  const got = languageOf(answer)
  return want === null || got === null || want === got ? 1 : 0
}

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/** Sentences by terminal punctuation followed by a space or the end; a decimal point or an abbreviation dot does not end one. */
export const sentenceCount = (text: string) => (text.trim().match(/[.!?…]+(?=\s+\p{Lu}|\s*$)/gu) ?? []).length

/** Markup a voice would read out: a heading, a list marker, emphasis, a code span, a link, a table bar. */
const MARKUP = /(^|\n)\s*([#>*-]|\d+\.)\s|\*\*|__|`|\]\(|\|/

export const hasMarkup = (text: string) => MARKUP.test(text)

/** The share of `mustMention` terms the text holds; 1 with none. */
export function mentionShare(text: string, terms: string[]): number {
  return terms.length === 0 ? 1 : terms.filter((t) => mentions(text, t)).length / terms.length
}

/** 1 when no `forbid` string is in the text. */
export const clean = (text: string, forbid: string[]) => (forbid.some((f) => lower(text).includes(lower(f))) ? 0 : 1)

/** A block of text the judge reads, cut so a long memo stays inside the decision API's limit. */
export const excerpt = (text: string, max = 4_000) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text)
