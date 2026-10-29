import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { asRecord } from '../research/util.ts'
import { type OtelInputValue, OtelOutput, Severity, Status } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const OTEL_SCORER_VERSION = '2026-10-29.1'

/** A case's expected result, written from direct queries before any arm runs: the status and 1-3 key facts. */
export const OtelReference = z.object({
  status: Status,
  facts: z.array(z.string().min(1)).min(1).max(3),
})
export type OtelReference = z.output<typeof OtelReference>

/**
 * The shape both arms share: agent-gateway's `OTEL_OUTPUT` (the legacy tool's answer) with the new flag optional.
 * `valid` is this shape, so the legacy arm is scored by the same function; `grounded` needs the new arm's `queries`.
 */
export const Scorable = OtelOutput.pick({
  status: true,
  environment: true,
  timeRange: true,
  recommendations: true,
}).extend({
  findings: z.array(
    z.object({
      service: z.string(),
      summary: z.string(),
      severity: Severity,
      evidence: z.string().optional(),
      unverified: z.boolean().optional(),
    }),
  ),
})

const FACT_PREFIX = 'fact'

/** The result as the judge reads it: the verdict, the window, every finding with its evidence, the recommendations. */
function stateOf(result: z.output<typeof Scorable>): string {
  const findings = result.findings.map(
    (f) => `- [${f.severity}] ${f.service}: ${f.summary}${f.evidence ? ` (evidence: ${f.evidence})` : ''}`,
  )
  return [
    `Status: ${result.status}`,
    `Window: ${result.timeRange}`,
    `Findings:\n${findings.join('\n') || '(none)'}`,
    `Recommendations:\n${result.recommendations.map((r) => `- ${r}`).join('\n') || '(none)'}`,
  ].join('\n\n')
}

/**
 * The `otel` scorer (concept §6, wave 7 ports). Every score is in [0, 1], higher is better:
 * - `valid`: the output parses as the shared shape (else every other score is 0);
 * - `status` (with a reference): the answered status equals the expected one;
 * - `facts` (judged, with a reference): the share of the reference's facts the result states, one `decide` boolean per
 *   fact; left out without a judge or when the judge could not answer;
 * - `grounded` (the new arm only: it needs `queries`): the share of findings not flagged `unverified`, counted in code
 *   from the run's tool calls; left out when there are no findings.
 * `pass`: valid, and with a reference the status matches and every fact is stated (an unscored `facts` never passes).
 */
export const otelScorer: Scorer<OtelInputValue, OtelReference> = {
  version: OTEL_SCORER_VERSION,
  reference: OtelReference,
  async score(_input, output, ctx): Promise<Verdict> {
    const parsed = Scorable.safeParse(output)
    if (!parsed.success) {
      const scores: Record<string, number> = { valid: 0 }
      if (ctx.reference) scores.status = 0
      if (ctx.reference && ctx.judge) scores.facts = 0
      return { scores, pass: false, feedback: output === null ? 'the run failed' : 'the output is not an otel result' }
    }
    const result = parsed.data
    const scores: Record<string, number> = { valid: 1 }
    const problems: string[] = []
    const hasQueries = Array.isArray(asRecord(output).queries)
    if (hasQueries && result.findings.length > 0) {
      scores.grounded = result.findings.filter((f) => f.unverified !== true).length / result.findings.length
      if (scores.grounded < 1) problems.push('ungrounded finding(s)')
    }

    let pass = true
    if (ctx.reference) {
      const { status, facts } = ctx.reference
      scores.status = result.status === status ? 1 : 0
      if (scores.status === 0) problems.push(`status ${result.status}, expected ${status}`)
      let factsStated: number | null = null
      if (ctx.judge) {
        const questions = Object.fromEntries(
          facts.map((fact, i) => [
            `${FACT_PREFIX}${i}`,
            {
              type: 'boolean' as const,
              instructions:
                `Does the result state this fact: "${fact}"? True when it names the same service, error or figure ` +
                'with the same meaning (numbers within rounding). False when it is absent, contradicted or only vaguely hinted.',
            },
          ]),
        )
        const decided = asRecord(await ctx.judge('decide', { state: stateOf(result), questions }))
        if (decided.error === undefined) {
          const answers = asRecord(decided.answers)
          const values = facts.map((_f, i) => asRecord(answers[`${FACT_PREFIX}${i}`]).value)
          if (values.every((v) => typeof v === 'boolean')) {
            factsStated = values.filter((v) => v === true).length / facts.length
            scores.facts = factsStated
            if (factsStated < 1)
              problems.push(`${facts.length - values.filter((v) => v === true).length} fact(s) missed`)
          }
        }
        if (factsStated === null) problems.push('facts unscored: the judge gave no usable answer')
      }
      pass = scores.status === 1 && factsStated === 1
    }
    return { scores, pass, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}
