import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONTROLS,
  type Exec,
  exec as bunExec,
  GtCandidate,
  type GtLabelRecord,
  MINER_VERSION,
  mine,
  seededShuffle,
} from '@agent-workflows/eval'
import { defineWorkflow, type Logger, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import {
  appendLabel,
  type CaseSummary,
  controlCases,
  hasSeatError,
  latestLabels,
  readOwnerEmails,
  readRecords,
  rebuildCases,
  type Warn,
  writeCandidates,
  writeReport,
} from './files.ts'
import { LABELER_VERSION, type LabelCaller, labelCandidate } from './label.ts'

export { LABELER_VERSION, type LabelCaller, seatAnswer } from './label.ts'

export const EVAL_MINE_ID = 'eval.mine'
const DEFAULT_CONCURRENCY = 2
/** The estimate reads the latest this many done `cap.eval.label` runs. */
const ESTIMATE_HISTORY = 20
const LABEL_CAPABILITY_WORKFLOW = 'cap.eval.label'
const CALLS_PER_CANDIDATE = 2

/** What the estimate reads of the journal: `Runtime.recentCost`. A host that cannot read it leaves the estimate unknown. */
export interface CostHistory {
  recentCost(workflow: string, limit: number): Promise<{ runs: number; meanCost: number | null }>
}

export interface EvalMineOptions {
  registry: LabelCaller
  env?: Record<string, string | undefined>
  exec?: Exec
  now?: () => Date
  history?: CostHistory
  /** Where a skipped torn line is reported. Default: the console. */
  logger?: Pick<Logger, 'warn'>
}

export const evalMineInput = z
  .object({
    suite: z.enum(['review']).describe('The suite whose ground truth is mined'),
    label: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Candidates to label this run (two paid calls each), default 0: mine only'),
    seed: z.number().int().optional().describe('Seed of the label order and the control pick, default 1'),
    controls: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe(`Clean controls to pick, default ${DEFAULT_CONTROLS}`),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe(`Candidates labelled at once, default ${DEFAULT_CONCURRENCY}`),
    relabelErrors: z
      .boolean()
      .optional()
      .describe('Label again the candidates whose last record has a seat error (never retried otherwise)'),
    yes: z.boolean().optional().describe('Label: spends eval credit. Without it, mining and the labelling plan only'),
  })
  .strict()

const Estimate = z.object({
  historyRuns: z.number().int().describe('Done `cap.eval.label` runs the mean is taken over'),
  meanCostUsd: z.number().nullable(),
  totalUsd: z.number().nullable().describe('2 calls × the mean × candidates; null without priced history'),
})

const Summary = z.object({
  labelled: z.number().int().describe('Candidates with a label record under the current labeler version'),
  accepted: z.number().int(),
  rejected: z.object({ total: z.number().int(), byReason: z.record(z.string(), z.number().int()) }),
  bugClasses: z.record(z.string(), z.number().int()),
  cases: z.object({
    dev: z.object({ bug: z.number().int(), control: z.number().int() }),
    test: z.object({ bug: z.number().int(), control: z.number().int() }),
  }),
})

export const evalMineOutput = z.object({
  suite: z.enum(['review']),
  minerVersion: z.string(),
  labelerVersion: z.string(),
  funnel: z.record(z.string(), z.number().int()),
  labelPlan: z
    .object({ candidates: z.number().int().describe('Unlabelled candidates this run would label'), estimate: Estimate })
    .nullable()
    .describe('Null without --label'),
  spent: z.boolean().describe('False: no label call was made (no --label, or no --yes)'),
  labelledThisRun: z.number().int(),
  stopped: z
    .string()
    .nullable()
    .describe('The first error that is not a seat answer (no eval credit, an outage); labelling stopped there'),
  summary: Summary,
  runId: z.string(),
})

/** The unlabelled candidates in the seeded order (the owner sample is random, and the order survives growing labels). */
function pending(
  candidates: GtCandidate[],
  labels: Map<string, GtLabelRecord>,
  options: { seed: number; relabelErrors: boolean },
) {
  const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return seededShuffle(ordered, options.seed).filter((c) => {
    const record = labels.get(c.id)
    return !record || (options.relabelErrors && hasSeatError(record))
  })
}

/**
 * `agw eval mine review`: the ground-truth miner (`docs/review-v2.md` §Ground truth). It mines SZZ candidates and clean
 * controls from the owner's history (`candidates.jsonl`, `report.json`), and with `--label N --yes` labels the next N
 * unlabelled candidates on two vendors (`labels.jsonl`, one record as each finishes), then rebuilds `cases.jsonl` and
 * `rejected.jsonl` from every record. Everything is under `$AGW_EVAL_DIR/review-gt/`; the journal holds counts only.
 */
export function createEvalMine(options: EvalMineOptions): HostWorkflow {
  const env = options.env ?? process.env
  const warn: Warn = (message, meta) =>
    options.logger ? options.logger.warn(message, meta) : console.warn(`[agw-eval-mine] ${message}`, meta ?? '')
  const exec = options.exec ?? bunExec
  const now = options.now ?? (() => new Date())
  const homeOf = () => env.AGW_EVAL_HOME?.trim() || homedir()

  const workflow = defineWorkflow({
    id: EVAL_MINE_ID,
    version: '2026-11-02.2',
    // One writer of the ground-truth files at a time: two runs would race on candidates and labels.
    concurrency: 1,
    input: evalMineInput,
    output: evalMineOutput,
    async run(ctx, input) {
      const seed = input.seed ?? 1
      const wanted = input.label ?? 0
      const relabelErrors = input.relabelErrors ?? false

      const mined = await ctx.step('mine', async () => {
        const result = await mine({
          root: join(homeOf(), 'SourceRoot'),
          exec,
          now: now(),
          seed,
          controls: input.controls,
          ownerEmails: readOwnerEmails(env),
        })
        // A mine that lost a repo (or found none) would shrink the ground truth silently: keep the files, say why.
        if (result.skipped.length > 0 || result.funnel.repos === 0) {
          writeReport(
            {
              at: now().toISOString(),
              minerVersion: MINER_VERSION,
              incomplete: true,
              skippedRepos: result.skipped,
              funnel: result.funnel,
            },
            env,
          )
          const names = result.skipped.map((s) => s.repo).join(', ')
          throw new WorkflowError(
            'error',
            result.funnel.repos === 0
              ? 'mining found no repositories to mine; candidates.jsonl and cases.jsonl are untouched'
              : `mining is incomplete, ${result.skipped.length} repos failed (${names}; errors in report.json); candidates.jsonl and cases.jsonl are untouched`,
          )
        }
        writeCandidates(result.candidates, env)
        const summary = rebuildCases({
          env,
          warn,
          labelerVersion: LABELER_VERSION,
          controls: controlCases(result.controls),
        })
        writeReport(report(result.funnel, summary, now()), env)
        return { funnel: { ...result.funnel }, summary }
      })

      const candidates = () => readRecords('candidates.jsonl', GtCandidate, env, warn)
      const plan = wanted
        ? await ctx.step('plan', async () => {
            const toLabel = Math.min(
              wanted,
              pending(candidates(), latestLabels(env, LABELER_VERSION, warn), { seed, relabelErrors }).length,
            )
            const history = (await options.history?.recentCost(LABEL_CAPABILITY_WORKFLOW, ESTIMATE_HISTORY)) ?? {
              runs: 0,
              meanCost: null,
            }
            return {
              candidates: toLabel,
              estimate: {
                historyRuns: history.runs,
                meanCostUsd: history.meanCost,
                totalUsd: history.meanCost === null ? null : history.meanCost * CALLS_PER_CANDIDATE * toLabel,
              },
            }
          })
        : null
      const base = {
        suite: input.suite,
        minerVersion: MINER_VERSION,
        labelerVersion: LABELER_VERSION,
        funnel: mined.funnel,
        labelPlan: plan,
        runId: ctx.runId,
      }
      if (!plan || !input.yes) {
        return { ...base, spent: false, labelledThisRun: 0, stopped: null, summary: mined.summary }
      }

      const labelled = await ctx.step('label', ({ callContext, signal, progress }) =>
        runLabelling({
          env,
          warn,
          exec,
          home: homeOf(),
          now,
          registry: options.registry,
          callContext,
          signal,
          progress,
          runId: ctx.runId,
          seed,
          relabelErrors,
          wanted,
          concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
        }),
      )
      const summary = await ctx.step('cases', () => {
        const rebuilt = rebuildCases({ env, warn, labelerVersion: LABELER_VERSION })
        writeReport(report(mined.funnel, rebuilt, now()), env)
        return rebuilt
      })
      return { ...base, spent: true, labelledThisRun: labelled.labelled, stopped: labelled.stopped, summary }
    },
  })
  return {
    workflow,
    summary:
      'Mine the review ground truth from the owner’s fix history; --label N --yes labels N candidates on two vendors (spends)',
    cli: { positional: ['suite'], defaultFormat: 'json', mutating: true },
  }
}

/** `report.json`: aggregates only, the input of the committed report. */
function report(funnel: Record<string, number>, summary: CaseSummary, at: Date) {
  return {
    at: at.toISOString(),
    minerVersion: MINER_VERSION,
    labelerVersion: LABELER_VERSION,
    funnel,
    labelled: summary.labelled,
    accepted: summary.accepted,
    acceptanceRate: summary.labelled ? summary.accepted / summary.labelled : null,
    rejected: summary.rejected,
    bugClasses: summary.bugClasses,
    cases: summary.cases,
  }
}

type Labelling = {
  env: Record<string, string | undefined>
  warn: Warn
  exec: Exec
  home: string
  now: () => Date
  registry: LabelCaller
  callContext: Parameters<typeof labelCandidate>[0]['callContext']
  signal: AbortSignal
  progress: () => void
  runId: string
  seed: number
  relabelErrors: boolean
  wanted: number
  concurrency: number
}

/**
 * Labels the next unlabelled candidates, `concurrency` at a time, each record appended as its candidate finishes. A
 * resumed run counts the records it already wrote (by run id) against `wanted`. Stops taking candidates at the first
 * failure that is not a seat answer. Those in flight always finish and keep their records, an abort or a failed write
 * included, before the failure is rethrown.
 */
async function runLabelling(job: Labelling): Promise<{ labelled: number; stopped: string | null }> {
  const labels = latestLabels(job.env, LABELER_VERSION, job.warn)
  const done = [...labels.values()].filter((r) => r.runId === job.runId).length
  const queue = pending(readRecords('candidates.jsonl', GtCandidate, job.env, job.warn), labels, job).slice(
    0,
    Math.max(0, job.wanted - done),
  )
  let next = 0
  let labelled = done
  let stopped: string | null = null
  /** An abort or a failed write: no worker takes another candidate, those in flight finish, then it is rethrown. */
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (stopped === null && failure === null && next < queue.length) {
      const candidate = queue[next++] as GtCandidate
      try {
        job.signal.throwIfAborted()
        const outcome = await labelCandidate({
          candidate,
          home: job.home,
          exec: job.exec,
          registry: job.registry,
          callContext: job.callContext,
          runId: job.runId,
          now: job.now,
        })
        if ('stop' in outcome) {
          stopped ??= outcome.stop
          return
        }
        appendLabel(outcome.record, job.env)
        labelled++
        job.progress()
      } catch (error) {
        if (job.signal.aborted) failure ??= { error: job.signal.reason ?? error }
        else failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.concurrency, queue.length)) }, worker))
  if (failure) throw (failure as { error: unknown }).error
  return { labelled, stopped }
}
