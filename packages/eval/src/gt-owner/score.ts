import type { OwnerLabel } from '../gt.ts'
import type { ManifestItem } from './manifest.ts'
import { agreement, type Confusion, cohenKappa, wilson } from './stats.ts'

export const CASE_BAR = 0.9
export const KAPPA_BAR = 0.8

type Verdict = OwnerLabel['verdict']
type Interval = { p: number; lo: number; hi: number } | null

const idOf = (label: OwnerLabel) => (label.kind === 'case' ? label.candidateId : label.pairId)

/** The label each item ends up with: the later line of the file wins. Labels naming no item of the manifest are returned apart. */
export function effectiveLabels(items: readonly ManifestItem[], labels: readonly OwnerLabel[]) {
  const known = new Set(items.map((i) => `${i.kind}:${i.id}`))
  const byKey = new Map<string, OwnerLabel>()
  const unknown: OwnerLabel[] = []
  for (const label of labels) {
    const key = `${label.kind}:${idOf(label)}`
    if (known.has(key)) byKey.set(key, label)
    else unknown.push(label)
  }
  return { byKey, unknown }
}

const tally = (verdicts: Verdict[]) => ({
  answered: verdicts.length,
  yes: verdicts.filter((v) => v === 'yes').length,
  no: verdicts.filter((v) => v === 'no').length,
  unsure: verdicts.filter((v) => v === 'unsure').length,
})

export type SessionReport = {
  cases: {
    accepted: ReturnType<typeof tally> & { shown: number; precision: number | null; ci95: Interval }
    /** `yes` on a rejected candidate is a real bug the filters lose. */
    rejected: ReturnType<typeof tally> & { shown: number; lost: number | null; ci95: Interval }
  }
  pairs: {
    shown: number
    n: number
    unsure: number
    agreement: number | null
    kappa: number | null
    /** Owner (rows) against the judge (columns): `yy` owner yes and judge match. */
    confusion: Confusion
  }
  bars: {
    cases: { threshold: number; value: number | null; met: boolean | null }
    kappa: { threshold: number; value: number | null; met: boolean | null }
  }
  unanswered: { cases: number; pairs: number }
}

/** Case and pair statistics of an owner session against its manifest (`docs/review-v2.md` §Ground truth step 5). */
export function scoreSession(items: readonly ManifestItem[], labels: readonly OwnerLabel[]): SessionReport {
  const { byKey } = effectiveLabels(items, labels)
  const verdictOf = (item: ManifestItem): Verdict | undefined => byKey.get(`${item.kind}:${item.id}`)?.verdict

  const group = (truth: 'accepted' | 'rejected') => {
    const shown = items.filter((i) => i.kind === 'case' && i.truth === truth)
    const answered = shown.flatMap((i) => verdictOf(i) ?? [])
    return { shown: shown.length, ...tally(answered) }
  }
  const accepted = group('accepted')
  const rejected = group('rejected')
  const acceptedP = wilson(accepted.yes, accepted.yes + accepted.no)
  const rejectedP = wilson(rejected.yes, rejected.yes + rejected.no)

  const confusion: Confusion = { yy: 0, yn: 0, ny: 0, nn: 0 }
  let pairsShown = 0
  let unsure = 0
  for (const item of items) {
    if (item.kind !== 'pair') continue
    pairsShown++
    const verdict = verdictOf(item)
    if (verdict === 'unsure') unsure++
    if (verdict !== 'yes' && verdict !== 'no') continue
    const judged = item.judgeClass === 'match'
    if (verdict === 'yes') confusion[judged ? 'yy' : 'yn']++
    else confusion[judged ? 'ny' : 'nn']++
  }
  const kappa = cohenKappa(confusion)
  const precision = acceptedP?.p ?? null

  const unanswered = (kind: 'case' | 'pair') => items.filter((i) => i.kind === kind && !verdictOf(i)).length
  return {
    cases: {
      accepted: { ...accepted, precision, ci95: acceptedP },
      rejected: { ...rejected, lost: rejectedP?.p ?? null, ci95: rejectedP },
    },
    pairs: {
      shown: pairsShown,
      n: confusion.yy + confusion.yn + confusion.ny + confusion.nn,
      unsure,
      agreement: agreement(confusion),
      kappa,
      confusion,
    },
    bars: {
      cases: { threshold: CASE_BAR, value: precision, met: precision === null ? null : precision >= CASE_BAR },
      kappa: { threshold: KAPPA_BAR, value: kappa, met: kappa === null ? null : kappa >= KAPPA_BAR },
    },
    unanswered: { cases: unanswered('case'), pairs: unanswered('pair') },
  }
}
