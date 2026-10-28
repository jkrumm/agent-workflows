import type { Judge, Located } from './ports.ts'

/**
 * Finding matcher. The reference side (legacy blocking) is matched one-to-one against the candidate side.
 * Deterministic first: same file, lines within `lineWindow` (or both line-less), and enough shared message
 * tokens. A pair that is close but not clearly the same is `unsure`; only those go to the judge.
 */
export const MATCH = {
  lineWindow: 5,
  /** Overlap coefficient of message tokens that makes a located pair a match. */
  sameText: 0.3,
  /** Shared tokens a deterministic match also needs: one shared word with a two-word message is not enough. */
  minShared: 2,
} as const

export type PairKind = 'match' | 'unsure' | 'none'

const STOP = new Set(
  'the and for with this that from are was were not but can will into when then than its has have should would could may might must use used uses using also only does doing which while where there here these those they them their what been being just more less any all each other some such like via per'.split(
    ' ',
  ),
)

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )
}

/** |A ∩ B| / min(|A|, |B|): a terse finding and a verbose one about the same thing still score high. */
export function overlap(a: string, b: string): { score: number; shared: number } {
  const ta = tokens(a)
  const tb = tokens(b)
  const smaller = Math.min(ta.size, tb.size)
  if (smaller === 0) return { score: 0, shared: 0 }
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return { score: shared / smaller, shared }
}

export const normalizePath = (file: string) =>
  file
    .trim()
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')

export function classifyPair(a: Located, b: Located): { kind: PairKind; score: number } {
  if (normalizePath(a.file) !== normalizePath(b.file)) return { kind: 'none', score: 0 }
  const { score, shared } = overlap(a.message, b.message)
  const sameText = score >= MATCH.sameText && shared >= MATCH.minShared
  const aLine = a.line ?? null
  const bLine = b.line ?? null
  const near =
    (aLine === null && bLine === null) ||
    (aLine !== null && bLine !== null && Math.abs(aLine - bLine) <= MATCH.lineWindow)
  if (near) return { kind: sameText ? 'match' : 'unsure', score }
  return { kind: sameText ? 'unsure' : 'none', score }
}

export interface MatchResult {
  reference: number
  candidate: number
  /** Reference findings matched, deterministically or by the judge. */
  matched: number
  /** Of `matched`, how many the judge decided. */
  judged: number
  /** Reference findings left unmatched that had an unsure pair (no judge, or the judge said no). */
  unsure: number
  /** Index pairs [reference, candidate] that matched. */
  pairs: [number, number][]
}

/** Greedy one-to-one: sure matches by score first, then the unsure pairs through the judge when there is one. */
export async function matchFindings(
  reference: Located[],
  candidate: Located[],
  options: { judge?: Judge; diff?: string } = {},
): Promise<MatchResult> {
  const scored: { r: number; c: number; kind: PairKind; score: number }[] = []
  reference.forEach((a, r) => {
    candidate.forEach((b, c) => {
      const { kind, score } = classifyPair(a, b)
      if (kind !== 'none') scored.push({ r, c, kind, score })
    })
  })
  scored.sort((x, y) => y.score - x.score)
  const usedR = new Set<number>()
  const usedC = new Set<number>()
  const pairs: [number, number][] = []
  const take = (r: number, c: number) => {
    usedR.add(r)
    usedC.add(c)
    pairs.push([r, c])
  }
  for (const p of scored) if (p.kind === 'match' && !usedR.has(p.r) && !usedC.has(p.c)) take(p.r, p.c)

  let judged = 0
  const asked = new Set<number>()
  for (const p of scored) {
    if (p.kind !== 'unsure' || usedR.has(p.r) || usedC.has(p.c)) continue
    asked.add(p.r)
    if (!options.judge) continue
    const a = reference[p.r] as Located
    const b = candidate[p.c] as Located
    if (await options.judge.sameDefect({ a, b, diff: options.diff ?? '' })) {
      take(p.r, p.c)
      judged++
    }
  }
  const unsure = [...asked].filter((r) => !usedR.has(r)).length
  return { reference: reference.length, candidate: candidate.length, matched: pairs.length, judged, unsure, pairs }
}
