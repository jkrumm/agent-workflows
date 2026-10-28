import { type ArmRun, type Comparison, compareArms } from '@agent-workflows/eval'
import { defineWorkflow, type Json, type ScoredRun, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { JsonRecord } from './run.ts'
import type { EvalSlot } from './slot.ts'
import { SUITE_IDS } from './suites.ts'

export const EVAL_COMPARE_ID = 'eval.compare'

export const EvalCompareInput = z
  .object({
    workflow: z.enum(SUITE_IDS).describe('The workflow whose regression runs to compare'),
    a: z.string().min(8).describe('Arm A: a fingerprint, or a unique prefix of one (at least 8 characters)'),
    b: z.string().min(8).describe('Arm B: a fingerprint or a unique prefix; may equal A when the args differ'),
    aArgs: JsonRecord.optional().describe('Arm A: the --args its eval runs used, exactly (default {})'),
    bArgs: JsonRecord.optional().describe('Arm B: the --args its eval runs used, exactly (default {})'),
    seed: z.number().int().optional().describe('Bootstrap seed, default 1: the same seed gives the same CIs'),
  })
  .strict()

const Ci = z.tuple([z.number(), z.number()]).nullable()

const Arm = z.object({
  fingerprint: z.string(),
  args: JsonRecord,
  runs: z.number().int(),
  scorers: z.array(z.string()).describe('Scorer versions of its runs'),
})

export const EvalCompareOutput = z.object({
  workflow: z.enum(SUITE_IDS),
  a: Arm,
  b: Arm,
  cases: z.object({
    a: z.number().int(),
    b: z.number().int(),
    paired: z.number().int(),
    onlyA: z.array(z.string()),
    onlyB: z.array(z.string()),
    unpricedCost: z
      .object({ a: z.number().int(), b: z.number().int() })
      .describe('Paired cases left out of costUsd on that side: their runs had unpriced calls'),
  }),
  metrics: z.array(
    z.object({
      metric: z.string(),
      direction: z.enum(['higher', 'lower']),
      n: z.number().int(),
      meanA: z.number().nullable(),
      meanB: z.number().nullable(),
      meanDelta: z.number().nullable(),
      meanDeltaCi95: Ci,
      medianDelta: z.number().nullable(),
      medianDeltaCi95: Ci,
      better: z.enum(['a', 'b', 'tie', 'unknown']),
    }),
  ),
  bBetter: z.array(z.string()).describe('Metrics where B beats A with the 95% CI of the mean delta clear of 0'),
  bWorse: z.array(z.string()),
  warnings: z.array(z.string()),
})

/** Canonical JSON (keys sorted), so `{"x":1,"y":2}` and `{"y":2,"x":1}` name the same arm. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A scored run as compare reads it; spend that is a lower bound (unpriced calls) is left out, never compared. */
function armRun(run: ScoredRun): ArmRun | null {
  const caseId = run.final.caseId
  if (!caseId) return null
  return {
    caseId,
    scores: run.final.scores,
    pass: run.final.pass,
    costUsd: run.unpricedCalls > 0 ? null : run.cost,
    wallMs: run.wallMs,
    tokens: run.tokens,
    toolCalls: run.toolCalls,
    ...(run.unpricedCalls > 0 ? { unpriced: true } : {}),
  }
}

/** The runs of one arm, read narrowed in SQL: a prefix that names exactly one fingerprint, and exactly these args. */
async function arm(slot: EvalSlot, workflow: string, side: string, prefix: string, args: Record<string, Json>) {
  const key = canonical(args)
  const matching = await slot.get().scoredRuns({ workflow, source: 'regression', fingerprintPrefix: prefix, args })
  const fingerprints = [...new Set(matching.map((r) => r.fingerprint as string))]
  if (fingerprints.length === 0) {
    throw new WorkflowError(
      'invalid_input',
      `arm ${side}: no regression runs with fingerprint ${prefix}… and args ${key}`,
    )
  }
  if (fingerprints.length > 1) {
    throw new WorkflowError(
      'invalid_input',
      `arm ${side}: ${prefix} names ${fingerprints.length} fingerprints: ${fingerprints.join(', ')}`,
    )
  }
  return {
    info: {
      fingerprint: fingerprints[0] as string,
      args,
      runs: matching.length,
      scorers: [...new Set(matching.map((r) => r.final.scorer))].sort(),
    },
    runs: matching.flatMap((r) => armRun(r) ?? []),
  }
}

/**
 * `agw eval compare <workflow> --a <fp> --b <fp>` (concept §6): better, cheaper, faster, fewer tokens, fewer tool
 * calls, with numbers. Two arms of regression runs, paired by case id, per metric: means, the mean and median delta
 * (B − A) with seeded bootstrap 95% CIs, and which arm the CI favours. An arm is a fingerprint plus the exact `--args`
 * its eval runs used: an input such as `angleVariant` changes behaviour without changing the fingerprint, so equal
 * fingerprints compare when the args differ. Reads only; spends nothing.
 */
export function createEvalCompare(slot: EvalSlot): HostWorkflow {
  const workflow = defineWorkflow({
    id: EVAL_COMPARE_ID,
    version: '2026-10-28.1',
    input: EvalCompareInput,
    output: EvalCompareOutput,
    async run(ctx, input) {
      const aArgs = input.aArgs ?? {}
      const bArgs = input.bArgs ?? {}
      if (input.a === input.b && canonical(aArgs) === canonical(bArgs)) {
        throw new WorkflowError('invalid_input', 'arms A and B are the same fingerprint and args')
      }
      return ctx.step('compare', async () => {
        const a = await arm(slot, input.workflow, 'A', input.a, aArgs)
        const b = await arm(slot, input.workflow, 'B', input.b, bArgs)
        if (a.info.fingerprint === b.info.fingerprint && canonical(aArgs) === canonical(bArgs)) {
          throw new WorkflowError('invalid_input', 'arms A and B name the same fingerprint and args')
        }
        const comparison: Comparison = compareArms(a.runs, b.runs, { seed: input.seed ?? 1 })
        const warnings: string[] = []
        for (const [side, info] of [
          ['A', a.info],
          ['B', b.info],
        ] as const) {
          if (info.scorers.length > 1) warnings.push(`arm ${side} mixes scorer versions (${info.scorers.join(', ')})`)
        }
        if (canonical(a.info.scorers) !== canonical(b.info.scorers)) {
          warnings.push(`scorer versions differ (A ${a.info.scorers.join(', ')}; B ${b.info.scorers.join(', ')})`)
        }
        const { paired, unpricedCost } = comparison.cases
        if (paired < 10) warnings.push(`only ${paired} paired cases`)
        const cost = comparison.metrics.find((m) => m.metric === 'costUsd')
        if (paired > 0 && (cost?.n ?? 0) < paired) {
          warnings.push(
            `cost compared on ${cost?.n ?? 0} of ${paired} paired cases (unpriced calls: ${unpricedCost.a} in A, ${unpricedCost.b} in B)`,
          )
        }
        return { workflow: input.workflow, a: a.info, b: b.info, ...comparison, warnings } as unknown as Json
      }) as Promise<z.input<typeof EvalCompareOutput>>
    },
  })
  return {
    workflow,
    summary: 'Compare two eval arms (fingerprint + args) paired by case: scores, cost, wall time, tokens, tool calls',
    cli: { positional: ['workflow'], defaultFormat: 'json' },
  }
}
