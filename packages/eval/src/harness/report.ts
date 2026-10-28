import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckAggregate, ReviewAggregate } from './aggregate.ts'
import type { CheckCaseResult, ReviewCaseResult } from './results.ts'
import type { RatioSummary } from './stats.ts'
import type { Verdict } from './verdict.ts'

export interface RunMeta {
  workflow: 'review' | 'check'
  startedAt: string
  finishedAt: string
  depthMode: 'matched' | 'router'
  rerunLegacy: boolean
  judge: boolean
  concurrency: number
  seed: number
}

export type Report =
  | { meta: RunMeta; aggregate: ReviewAggregate; verdict: Verdict; results: ReviewCaseResult[] }
  | { meta: RunMeta; aggregate: CheckAggregate; verdict: Verdict; results: CheckCaseResult[] }

export const AGGREGATE_HEADING = '## Aggregate (safe to publish)'
export const PRIVATE_HEADING = '## Per case (private: messages, paths, repo names)'

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
const num = (v: number | null, digits = 2) => (v === null ? 'n/a' : v.toFixed(digits))
const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(4)}`)
const ratio = (r: RatioSummary) =>
  `${num(r.median)} (95% CI ${r.ci95 ? `${num(r.ci95[0])}–${num(r.ci95[1])}` : 'n/a'}, n=${r.n})`

/** Writes `report.json` and `report.md` into the run directory (mode 0600: the per-case part is private). */
export function writeReport(dir: string, report: Report): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'report.md'), renderMarkdown(report), { mode: 0o600 })
}

export function renderMarkdown(report: Report): string {
  return [
    `# Eval: ${report.meta.workflow}, new vs agent-gateway`,
    '',
    AGGREGATE_HEADING,
    '',
    renderAggregate(report),
    '',
    PRIVATE_HEADING,
    '',
    report.meta.workflow === 'review'
      ? renderReviewCases(report.results as ReviewCaseResult[])
      : renderCheckCases(report.results as CheckCaseResult[]),
    '',
  ].join('\n')
}

/** Numbers only: no finding text, no file path, no repo name. Safe to paste into this public repo. */
export function renderAggregate(report: Report): string {
  const { meta, verdict } = report
  const cases = report.aggregate.cases
  const skipped = Object.entries(cases.skipped).map(([reason, n]) => `${reason} ${n}`)
  const lines = [
    `**Verdict: ${verdict.verdict}**${verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : ''}`,
    '',
    `Run ${meta.startedAt} to ${meta.finishedAt}; depth ${meta.depthMode}, legacy rerun ${meta.rerunLegacy ? 'on' : 'off'}, judge ${meta.judge ? 'on' : 'off'}, concurrency ${meta.concurrency}, bootstrap seed ${meta.seed}.`,
    `Cases: ${cases.total} total, ${cases.ok} ran, ${cases.errors} failed, skipped ${skipped.length ? skipped.join(', ') : '0'}.`,
    '',
    '| criterion | value | threshold | pass |',
    '|-|-|-|-|',
    ...verdict.criteria.map(
      (c) =>
        `| ${c.metric} | ${num(c.value, 3)} | ${c.op} ${c.threshold.toFixed(3)} | ${c.pass === null ? 'no data' : c.pass ? 'yes' : 'no'} |`,
    ),
    '',
  ]
  return [
    ...lines,
    ...(report.meta.workflow === 'review'
      ? reviewAggregateLines(report.aggregate as ReviewAggregate)
      : checkAggregateLines(report.aggregate as CheckAggregate)),
  ].join('\n')
}

function reviewAggregateLines(a: ReviewAggregate): string[] {
  const outcomes = Object.keys(a.outcome.confusion)
  return [
    '| metric | legacy | new |',
    '|-|-|-|',
    `| blocking findings | ${a.blocking.legacy} | ${a.blocking.new} |`,
    `| improvements per case | ${num(a.improvementsPerCase.legacy)} | ${num(a.improvementsPerCase.new)} |`,
    `| needs-human rate | ${pct(a.needsHumanRate.legacy)} | ${pct(a.needsHumanRate.new)} |`,
    `| failed-angle rate | ${pct(a.failedAngleRate.legacy)} | ${pct(a.failedAngleRate.new)} |`,
    `| cost total | ${usd(a.cost.legacyUsd)} | ${usd(a.cost.newUsd)} |`,
    '',
    `Blocking recall vs legacy: ${pct(a.blocking.recall)} (${a.blocking.matched}/${a.blocking.legacy}, ${a.blocking.judged} by the judge, ${a.blocking.unsure} unsure left unmatched); new-only blocking: ${a.blocking.newOnly}.`,
    `Outcome agreement: ${pct(a.outcome.agreement)}.`,
    `Cost ratio new/legacy (${a.cost.baseline}): median ${ratio(a.cost)}.`,
    `Wall ratio new/legacy (${a.wall.baseline}): median ${ratio(a.wall)}.`,
    a.selfAgreement
      ? `Legacy self-agreement (rerun vs recorded, ${a.selfAgreement.cases} cases): blocking recall ${pct(a.selfAgreement.blockingRecall)}, outcome agreement ${pct(a.selfAgreement.outcomeAgreement)}.`
      : 'Legacy self-agreement: not measured (no --rerun-legacy); fixed floors apply.',
    '',
    'Outcome confusion (rows legacy, columns new):',
    '',
    `| legacy \\ new | ${outcomes.join(' | ')} |`,
    `|-|${outcomes.map(() => '-').join('|')}|`,
    ...outcomes.map((l) => `| ${l} | ${outcomes.map((n) => a.outcome.confusion[l]?.[n] ?? 0).join(' | ')} |`),
  ]
}

function checkAggregateLines(a: CheckAggregate): string[] {
  const c = a.passed.confusion
  return [
    `Passed agreement: ${pct(a.passed.agreement)}; step agreement ${pct(a.steps.agreement)} over ${a.steps.compared} steps both ran.`,
    `Cost ratio new/legacy (${a.cost.baseline}): median ${ratio(a.cost)}; totals legacy ${usd(a.cost.legacyUsd)}, new ${usd(a.cost.newUsd)}.`,
    `Wall ratio new/legacy (${a.wall.baseline}): median ${ratio(a.wall)}.`,
    a.selfAgreement
      ? `Legacy self-agreement (${a.selfAgreement.cases} cases): passed ${pct(a.selfAgreement.passedAgreement)}, steps ${pct(a.selfAgreement.stepAgreement)}.`
      : 'Legacy self-agreement: not measured (no --rerun-legacy); fixed floors apply.',
    '',
    '| legacy \\ new | pass | fail |',
    '|-|-|-|',
    `| pass | ${c.legacyPass.pass} | ${c.legacyPass.fail} |`,
    `| fail | ${c.legacyFail.pass} | ${c.legacyFail.fail} |`,
  ]
}

const where = (f: { file: string; line?: number | null }) => (f.line ? `${f.file}:${f.line}` : f.file)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300)
const secs = (ms: number | null) => (ms === null ? 'n/a' : `${Math.round(ms / 1000)}s`)

function renderReviewCases(results: ReviewCaseResult[]): string {
  const lines = [
    '| case | repo | status | outcome legacy → new | blocking matched | new-only | cost legacy → new | wall legacy → new |',
    '|-|-|-|-|-|-|-|-|',
  ]
  for (const r of results) {
    const legacy = r.rerun ?? r.legacy
    lines.push(
      `| ${r.id} | ${r.repo} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${r.legacy.outcome} → ${r.new?.outcome ?? '-'} | ${r.match ? `${r.match.matched}/${r.match.reference}` : '-'} | ${r.match?.newOnly ?? '-'} | ${usd(legacy.costUsd)} → ${usd(r.new?.costUsd ?? null)} | ${secs(legacy.wallMs)} → ${secs(r.new?.wallMs ?? null)} |`,
    )
  }
  for (const r of results) {
    const details = [
      ...(r.detail ? [`- detail: ${oneLine(r.detail)}`] : []),
      ...(r.rerunError ? [`- legacy rerun failed: ${oneLine(r.rerunError)}`] : []),
      ...(r.missed ?? []).map((f) => `- missed: \`${where(f)}\` ${oneLine(f.message)}`),
      ...(r.newOnly ?? []).map((f) => `- new only: \`${where(f)}\` ${oneLine(f.message)}`),
    ]
    if (details.length) lines.push('', `### ${r.id}`, '', ...details)
  }
  return lines.join('\n')
}

function renderCheckCases(results: CheckCaseResult[]): string {
  const lines = [
    '| case | repo | status | passed legacy → new | steps new | cost legacy → new | wall legacy → new |',
    '|-|-|-|-|-|-|-|',
  ]
  for (const r of results) {
    const legacy = r.rerun ?? r.legacy
    const steps = r.new?.steps.map((s) => `${s.name}:${s.passed ? 'ok' : 'fail'}`).join(' ') ?? '-'
    lines.push(
      `| ${r.id} | ${r.repo} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${r.legacy.passed} → ${r.new?.passed ?? '-'} | ${steps} | ${usd(legacy.costUsd)} → ${usd(r.new?.costUsd ?? null)} | ${secs(legacy.wallMs)} → ${secs(r.new?.wallMs ?? null)} |`,
    )
  }
  for (const r of results) {
    if (r.detail) lines.push('', `### ${r.id}`, '', `- detail: ${oneLine(r.detail)}`)
  }
  return lines.join('\n')
}
