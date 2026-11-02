import { homedir } from 'node:os'
import { exec as bunExec, type Exec } from '@agent-workflows/eval'
import { defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { Pool } from 'pg'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { IngestError, ingestLabels } from './ingest.ts'
import { type JudgeRunReader, pgJudgeRuns } from './judge-runs.ts'
import { buildPack } from './pack.ts'

export const EVAL_GT_PACK_ID = 'eval.gt.pack'
export const EVAL_GT_INGEST_ID = 'eval.gt.ingest'

export interface EvalGtOptions {
  env?: Record<string, string | undefined>
  exec?: Exec
  /** Default: the journal in Postgres (`AGW_PG_URL`, `AGW_PG_SCHEMA`), one short-lived connection per pack. */
  judgeRuns?: JudgeRunReader
}

function envJudgeRuns(env: Record<string, string | undefined>): JudgeRunReader {
  return {
    async judgeRuns(evalRunIds) {
      const url = env.AGW_PG_URL?.trim()
      if (!url) throw new Error('AGW_PG_URL is not set: the pack reads the judge calls from the journal')
      const pool = new Pool({ connectionString: url, max: 1, application_name: 'agw-eval-gt-pack' })
      pool.on('error', () => {})
      try {
        return await pgJudgeRuns(pool, env.AGW_PG_SCHEMA?.trim() || 'agw').judgeRuns(evalRunIds)
      } finally {
        await pool.end()
      }
    },
  }
}

const Interval = z.object({ p: z.number(), lo: z.number(), hi: z.number() }).nullable()
const Bar = z.object({ threshold: z.number(), value: z.number().nullable(), met: z.boolean().nullable() })
const Tally = { answered: z.number().int(), yes: z.number().int(), no: z.number().int(), unsure: z.number().int() }

export function createEvalGtWorkflows(options: EvalGtOptions = {}): HostWorkflow[] {
  const env = options.env ?? process.env
  const exec = options.exec ?? bunExec
  const home = env.AGW_EVAL_HOME?.trim() || homedir()
  const judgeRuns = options.judgeRuns ?? envJudgeRuns(env)

  const pack = defineWorkflow({
    id: EVAL_GT_PACK_ID,
    version: '2026-11-02.1',
    input: z
      .object({
        evalRuns: z
          .array(z.string().min(1))
          .describe('Run ids of `agw eval run review` whose judge calls supply the pairs'),
        cases: z.number().int().nonnegative().optional().describe('Mined bug cases to show, default 50'),
        rejected: z.number().int().nonnegative().optional().describe('Dropped candidates to show, default 20'),
        pairs: z.number().int().nonnegative().optional().describe('Judge pairs to show, default 100'),
        seed: z.number().int().optional().describe('Sampling seed, default 1'),
      })
      .strict(),
    output: z.object({
      sessionId: z.string(),
      html: z.string().describe('The self-contained page: open it in a browser, from file://'),
      manifest: z.string().describe('The truth behind each item; never opened by the page'),
      counts: z.object({
        cases: z.number().int(),
        rejected: z.number().int(),
        pairs: z.number().int(),
        pairsJudgePositive: z.number().int(),
        pairsJudgeNegative: z.number().int(),
        total: z.number().int(),
      }),
      notes: z.array(z.string()).describe('Shortfalls and skipped items'),
    }),
    async run(ctx, input) {
      return ctx.step('pack', async () => {
        try {
          const { sessionId, html, manifest, counts, notes } = await buildPack(
            { env, exec, home, judgeRuns },
            {
              evalRuns: input.evalRuns,
              cases: input.cases ?? 50,
              rejected: input.rejected ?? 20,
              pairs: input.pairs ?? 100,
              seed: input.seed ?? 1,
            },
          )
          return { sessionId, html, manifest, counts, notes }
        } catch (error) {
          // The ground truth files are the caller's to fix (mine and label first); not an outage to retry.
          throw new WorkflowError('invalid_input', error instanceof Error ? error.message : String(error))
        }
      })
    },
  })

  const ingest = defineWorkflow({
    id: EVAL_GT_INGEST_ID,
    version: '2026-11-02.1',
    input: z
      .object({
        labels: z.string().min(1).describe('The content of owner-labels.jsonl exported from the session page'),
      })
      .strict(),
    output: z.object({
      appended: z.number().int(),
      duplicates: z.number().int().describe('Lines already in owner-labels.jsonl, not appended again'),
      unknown: z.number().int().describe('Lines naming no item of the current session, left out'),
      report: z.object({
        cases: z.object({
          accepted: z.object({
            ...Tally,
            shown: z.number().int(),
            precision: z.number().nullable(),
            ci95: Interval,
          }),
          rejected: z.object({
            ...Tally,
            shown: z.number().int(),
            lost: z.number().nullable().describe('Share of answered dropped candidates the owner calls real bugs'),
            ci95: Interval,
          }),
        }),
        pairs: z.object({
          shown: z.number().int(),
          n: z.number().int().describe('Pairs answered yes or no'),
          unsure: z.number().int(),
          agreement: z.number().nullable(),
          kappa: z.number().nullable(),
          confusion: z.object({
            yy: z.number().int(),
            yn: z.number().int(),
            ny: z.number().int(),
            nn: z.number().int(),
          }),
        }),
        bars: z.object({ cases: Bar, kappa: Bar }),
        unanswered: z.object({ cases: z.number().int(), pairs: z.number().int() }),
      }),
    }),
    async run(ctx, input) {
      return ctx.step('ingest', () => {
        try {
          return ingestLabels(env, input.labels)
        } catch (error) {
          if (error instanceof IngestError) throw new WorkflowError('invalid_input', error.message)
          throw error
        }
      })
    },
  })

  return [
    {
      workflow: pack,
      summary:
        'Build the owner session page (case check, judge calibration) from the mined ground truth; spends nothing',
    },
    {
      workflow: ingest,
      summary: 'Ingest the owner’s exported answers and report case precision, Cohen’s κ and the bars',
    },
  ]
}
