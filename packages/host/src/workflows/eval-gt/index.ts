import { writeFileAtomic, gtPath, GT_LIMIT, JudgeCalibration } from '@agent-workflows/eval'
import { defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { Pool } from 'pg'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import {
  CalibrateInputError,
  type CalibrationPlan,
  estimateCost,
  type JudgeCaller,
  planCalibration,
  runCalibration,
} from './calibrate.ts'
import { type JudgeRunReader, pgJudgeRuns } from './judge-runs.ts'

export const EVAL_GT_CALIBRATE_ID = 'eval.gt.calibrate'
const DEFAULT_PAIRS = 100
const DEFAULT_CONCURRENCY = 4

export interface EvalGtOptions {
  /** Judge `b`'s caller: any registry that serves `eval.judge`. */
  registry: JudgeCaller
  /** The workflow versions of the `cap.eval.judge` runs that count as judge `a`'s (`CalibrateDeps.judgeRunVersions`). */
  judgeRunVersions: readonly string[]
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Default: the journal in Postgres (`AGW_PG_URL`, `AGW_PG_SCHEMA`), one short-lived connection per calibration. */
  judgeRuns?: JudgeRunReader
}

function envJudgeRuns(env: Record<string, string | undefined>): JudgeRunReader {
  return {
    async judgeRuns(evalRunIds) {
      const url = env.AGW_PG_URL?.trim()
      if (!url) throw new Error('AGW_PG_URL is not set: the calibration reads the judge calls from the journal')
      const pool = new Pool({ connectionString: url, max: 1, application_name: 'agw-eval-gt-calibrate' })
      pool.on('error', () => {})
      try {
        return await pgJudgeRuns(pool, env.AGW_PG_SCHEMA?.trim() || 'agw').judgeRuns(evalRunIds)
      } finally {
        await pool.end()
      }
    },
  }
}

const Plan = z.object({
  pairs: z.number().int(),
  judgePositive: z.number().int(),
  judgeNegative: z.number().int(),
  judgeBCalls: z
    .number()
    .int()
    .describe('Calls still to make: one per judge-a run holding a sampled pair, less those already in judge-b.jsonl'),
  reused: z.number().int().describe('Judge-a runs whose judge-b answer is already on file'),
  skippedRuns: z
    .object({
      unusable: z.number().int(),
      unknownCase: z.number().int(),
      otherSeat: z.number().int(),
      otherVersion: z.number().int(),
    })
    .describe(
      'Judge runs left out: not a judge call, a case not in cases.jsonl, a judge-b run, a run of another capability version',
    ),
  estimateUsd: z.number().nullable().describe('Prompt size at the judge-b route’s rate; a rough figure'),
})

export const evalGtCalibrateOutput = z.object({
  limit: z.string().describe('What no one checked: every report of this ground truth states it'),
  plan: Plan,
  spent: z.boolean().describe('False: no judge call was made (no --yes)'),
  judgeB: z
    .object({
      asked: z.number().int().describe('Judge-b calls made this run'),
      reused: z.number().int().describe('Answers taken from judge-b.jsonl'),
      skippedAnswers: z.number().int().describe('Runs judge b gave no usable answer for'),
    })
    .nullable(),
  notes: z.array(z.string()).describe('Shortfalls and skipped runs'),
  calibration: z
    .custom<JudgeCalibration>((value) => JudgeCalibration.safeParse(value).success)
    .nullable()
    .describe('What was written to judge-calibration.json; null without --yes'),
  written: z.string().nullable().describe('The file, null without --yes'),
  scorer: z
    .string()
    .nullable()
    .describe('What review’s scorer does with it from the next host start: one judge, or both'),
})

const planOf = (plan: CalibrationPlan) => ({
  pairs: plan.pairs.length,
  judgePositive: plan.positives,
  judgeNegative: plan.negatives,
  judgeBCalls: plan.runs.size - plan.cached.size,
  reused: plan.cached.size,
  skippedRuns: plan.skipped,
  estimateUsd: estimateCost(plan),
})

/**
 * `agw eval gt calibrate`: how far two judges on different vendors agree (`docs/review-v2.md` §Matching and judging).
 * It takes the pairs (a finding and the case's bug) out of the judge-a calls of the given eval runs, half judge-positive
 * and half judge-negative, re-asks judge `b` on exactly those inputs, and writes Cohen's κ with its interval, the
 * agreement, the confusion table and the agreement on the unmatched classes to `review-gt/judge-calibration.json`.
 * Only judge-`a` runs of the current judge capability version are used. Each judge-`b` answer is appended to
 * `judge-b.jsonl` as it arrives, so a rerun asks only the missing ones and a stop keeps what was paid for.
 * Without `--yes` it prints the plan and spends nothing. No human checks it: the output states `GT_LIMIT`.
 */
export function createEvalGtWorkflows(options: EvalGtOptions): HostWorkflow[] {
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const judgeRuns = options.judgeRuns ?? envJudgeRuns(env)
  const deps = { env, judgeRuns, judge: options.registry, judgeRunVersions: options.judgeRunVersions }

  const calibrate = defineWorkflow({
    id: EVAL_GT_CALIBRATE_ID,
    version: '2026-11-03.1',
    concurrency: 1,
    input: z
      .object({
        evalRuns: z
          .array(z.string().min(1))
          .min(1)
          .describe('Run ids of `agw eval run review` whose judge calls supply the pairs'),
        pairs: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(`Pair budget, half judge-positive and half judge-negative, default ${DEFAULT_PAIRS}`),
        seed: z.number().int().optional().describe('Sampling seed, default 1'),
        yes: z.boolean().optional().describe('Spends: judge b is called. Without it, the plan only'),
      })
      .strict(),
    output: evalGtCalibrateOutput,
    async run(ctx, input) {
      const request = { evalRuns: input.evalRuns, pairs: input.pairs ?? DEFAULT_PAIRS, seed: input.seed ?? 1 }
      const planned = await ctx.step('plan', async () => {
        try {
          const plan = await planCalibration(deps, request)
          return { plan: planOf(plan), notes: plan.notes }
        } catch (error) {
          // Only the ground-truth files and the eval runs are the caller's to fix; a database failure is not.
          if (error instanceof CalibrateInputError) throw new WorkflowError('invalid_input', error.message)
          throw error
        }
      })
      if (!input.yes) {
        return {
          limit: GT_LIMIT,
          plan: planned.plan,
          spent: false,
          notes: planned.notes,
          judgeB: null,
          calibration: null,
          written: null,
          scorer: null,
        }
      }
      const done = await ctx.step('judge', async ({ callContext, signal, progress }) => {
        // The plan is rebuilt from the journal in this step: a step result holds counts, never the cases' content.
        const plan = await planCalibration(deps, request)
        return runCalibration(deps, plan, {
          callContext,
          signal,
          progress,
          now,
          concurrency: DEFAULT_CONCURRENCY,
          evalRuns: input.evalRuns,
        })
      })
      const written = gtPath('judge-calibration.json', env)
      writeFileAtomic(written, `${JSON.stringify(JudgeCalibration.parse(done.calibration), null, 2)}\n`)
      const { kappa, met } = done.calibration
      return {
        limit: GT_LIMIT,
        plan: planned.plan,
        spent: true,
        judgeB: { asked: done.asked, reused: done.reused, skippedAnswers: done.skippedRuns },
        notes: done.notes,
        calibration: done.calibration,
        written,
        scorer: met
          ? `κ ${kappa?.toFixed(3)} clears the bar: one judge (a)`
          : `κ ${kappa === null ? 'undefined' : kappa.toFixed(3)} is below the bar: both judges, a disagreement is unclear`,
      }
    },
  })

  return [
    {
      workflow: calibrate,
      summary:
        'Re-ask the second judge on recorded judge-a inputs and report Cohen’s κ, agreement and the confusion table (--yes spends)',
      cli: { defaultFormat: 'json', mutating: true },
    },
  ]
}
