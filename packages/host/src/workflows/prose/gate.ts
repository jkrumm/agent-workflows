import {
  addedContent,
  detectFormat,
  detectLanguage,
  formatViolation,
  type LintFinding,
  leftFenceOpen,
  lintProse,
  lostContent,
  type ProseFormat,
  type ProseLanguage,
} from './lint.ts'

/** Findings per rule. */
export function countByRule(findings: LintFinding[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1)
  return counts
}

/**
 * The first rule the rewrite has more findings of than the original, as "rule: after > before", or null when no rule
 * got worse. A swap (one finding fixed, a different rule introduced) keeps the total level and is still a regression.
 */
export function worsenedRule(before: LintFinding[], after: LintFinding[]): string | null {
  const baseline = countByRule(before)
  for (const [rule, count] of countByRule(after)) {
    const was = baseline.get(rule) ?? 0
    if (count > was) return `${rule}: ${count} > ${was}`
  }
  return null
}

/**
 * Whether a rewrite may replace the draft: it stays in the draft's format, keeps every fenced block, URL and wikilink
 * target, adds none, and no lint rule got worse. `reason` is why it may not (agent-gateway's `judgeRewrite`, verbatim
 * in its decisions and its reason strings).
 */
export function judgeRewrite(
  original: string,
  candidate: string,
  before: LintFinding[],
  language: ProseLanguage,
  format: ProseFormat,
): { reason: string | null; relint: LintFinding[] } {
  const relint = lintProse(candidate, language)
  const wrongFormat = formatViolation(format, candidate)
  if (wrongFormat) return { reason: wrongFormat, relint }
  if (leftFenceOpen(original, candidate)) return { reason: 'rewrite left a code fence open', relint }
  const lost = lostContent(original, candidate)
  if (lost) return { reason: `rewrite lost ${lost}`, relint }
  const added = addedContent(original, candidate)
  if (added) return { reason: `rewrite added ${added}`, relint }
  const worsened = worsenedRule(before, relint)
  if (worsened) return { reason: `rewrite has more lint findings (${worsened})`, relint }
  return { reason: null, relint }
}

export interface GateVerdict {
  kept: 'rewrite' | 'original'
  reason?: string
  language: ProseLanguage
  format: ProseFormat
  before: LintFinding[]
  after: LintFinding[]
}

/**
 * The keep gate over a finished rewrite, as the pipeline ran it: the language and format come from the original, the
 * rewrite is trimmed, and an empty one keeps the original. `after` is always the rewrite's own lint, kept or not.
 */
export function keepGate(input: { original: string; rewrite: string; language: ProseLanguage | 'auto' }): GateVerdict {
  const language = input.language === 'auto' ? detectLanguage(input.original) : input.language
  const format = detectFormat(input.original)
  const before = lintProse(input.original, language)
  const rewrite = input.rewrite.trim()
  if (!rewrite) {
    return { kept: 'original', reason: 'rewrite is empty', language, format, before, after: before }
  }
  const verdict = judgeRewrite(input.original, rewrite, before, language, format)
  return {
    kept: verdict.reason ? 'original' : 'rewrite',
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    language,
    format,
    before,
    after: verdict.relint,
  }
}
