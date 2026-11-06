import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONTROLS,
  type Exec,
  exec as bunExec,
  GT_LIMIT,
  GtCandidate,
  GtLabelRecord,
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
  type Versions,
  type Warn,
  writeCandidates,
  writeReport,
} from './files.ts'
import { AUTO_DEFAULTS, type AutoPorts, AutoRecord, perCandidateCosts, sizeRun } from './auto.ts'
import { LABELER_VERSION, type LabelCaller, labelCandidate } from './label.ts'

export { LABELER_VERSION, type LabelCaller, seatAnswer } from './label.ts'

const VERSIONS: Versions = { labelerVersion: LABELER_VERSION }

export const EVAL_MINE_ID = 'eval.mine'
const DEFAULT_CONCURRENCY = 2
/** The estimate reads the latest this many `eval.mine` runs that labelled and have a priced `label` step. */
const ESTIMATE_HISTORY = 20

/**
 * What the estimate reads of the journal: the cost of the `label` step of the newest `eval.mine` runs among `runIds`,
 * newest first, unpriced steps left out. A host that cannot read it leaves the estimate unknown.
 */
export interface CostHistory {
  labelStepCosts(options: { runIds: string[]; limit: number }): Promise<{ runId: string; cost: number }[]>
  /** The reads `--auto` sizes a run from; absent: `--auto` fails on its sizing step, naming this. */
  auto?: AutoPorts
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
      .describe('New candidates to label this run (two paid calls each), default: mine only'),
    auto: z
      .boolean()
      .optional()
      .describe(
        'Size the labelling itself (exclusive with --label): label nothing at the target, else as many candidates as the gateway eval credit and the IU line allow. With --yes it spends; the sizing is in the run output (`auto`)',
      ),
    target: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`--auto: bug cases (dev + test) the ground truth needs, default ${AUTO_DEFAULTS.target}`),
    iuLineUsd: z
      .number()
      .positive()
      .optional()
      .describe(
        `--auto: the line on IU eval spend (the personal key's eval workflows, not its whole total) in USD, default ${AUTO_DEFAULTS.iuLineUsd}`,
      ),
    iuMarginUsd: z
      .number()
      .min(0)
      .optional()
      .describe(`--auto: kept under the IU line, default ${AUTO_DEFAULTS.iuMarginUsd}`),
    iuSince: z.iso
      .datetime()
      .optional()
      .describe(`--auto: IU eval spend counts from this instant, default ${AUTO_DEFAULTS.iuSince}`),
    maxPerRun: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`--auto: most candidates one run labels, default ${AUTO_DEFAULTS.maxPerRun}`),
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
  .refine((input) => !(input.auto && input.label !== undefined), { message: '--auto and --label are exclusive' })

const Estimate = z.object({
  historyRuns: z
    .number()
    .int()
    .describe('`eval.mine` runs the mean is taken over (priced `label` step, at least one label)'),
  meanCostUsd: z.number().nullable(),
  totalUsd: z
    .number()
    .nullable()
    .describe('The mean cost per labelled candidate (both labeller calls) × candidates; null without priced history'),
})

const Summary = z.object({
  labelled: z.number().int().describe('Candidates with a label record under the current labeler version'),
  accepted: z.number().int(),
  acceptPaths: z.object({ 'a+b': z.number().int() }),
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
  limit: z.string().describe('What no one checked: every report of this ground truth states it'),
  funnel: z.record(z.string(), z.number().int()),
  labelPlan: z
    .object({
      candidates: z.number().int().describe('Unlabelled candidates this run would label'),
      estimate: Estimate,
    })
    .nullable()
    .describe('Null without --label'),
  auto: AutoRecord.nullable().describe(
    'Null without --auto. How many candidates this run labelled and why: the bug-case count before and after, the credit and IU reads, the per-candidate costs',
  ),
  spent: z.boolean().describe('False: no label call was made (no --label, or no --yes)'),
  labelledThisRun: z.number().int(),
  stopped: z
    .string()
    .nullable()
    .describe('The first error that is not a seat answer (no eval credit, an outage); labelling stopped there'),
  summary: Summary,
  runId: z.string(),
})

/** The unlabelled candidates in the seeded order (the order survives growing labels). */
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
 * `rejected.jsonl` from every record (both labellers must say defect at overlapping locations). `--auto` replaces `--label N`: the workflow sizes N from
 * the bug-case count, the gateway's eval credit and the IU line (`auto.ts`) and records why. Everything is under `$AGW_EVAL_DIR/review-gt/`; the
 * journal holds counts only. Every report states `GT_LIMIT`.
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
    version: '2026-11-06.1',
    // One writer of the ground-truth files at a time: two runs would race on candidates and labels.
    concurrency: 1,
    input: evalMineInput,
    output: evalMineOutput,
    async run(ctx, input) {
      const seed = input.seed ?? 1
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
              limit: GT_LIMIT,
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
          versions: VERSIONS,
          controls: controlCases(result.controls),
        })
        writeReport(report(result.funnel, summary, now()), env)
        return { funnel: { ...result.funnel }, summary }
      })

      const candidates = () => readRecords('candidates.jsonl', GtCandidate, env, warn)
      const auto = input.auto
        ? await ctx.step('size', () =>
            sizeAuto({ input, ports: options.history?.auto, summary: mined.summary, env, warn, seed, relabelErrors }),
          )
        : null
      const wanted = auto ? auto.planned : (input.label ?? 0)
      const labelling = auto !== null || input.label !== undefined
      const plan = labelling
        ? await ctx.step('plan', async () => {
            const labels = latestLabels(env, VERSIONS, warn)
            const toLabel = Math.min(wanted, pending(candidates(), labels, { seed, relabelErrors }).length)
            const estimate = await labelEstimate(options.history, env, warn)
            return {
              candidates: toLabel,
              estimate: {
                historyRuns: estimate.runs,
                meanCostUsd: estimate.meanCost,
                totalUsd: estimate.meanCost === null ? null : estimate.meanCost * toLabel,
              },
            }
          })
        : null
      const base = {
        suite: input.suite,
        minerVersion: MINER_VERSION,
        labelerVersion: LABELER_VERSION,
        limit: GT_LIMIT,
        funnel: mined.funnel,
        labelPlan: plan,
        runId: ctx.runId,
      }
      const bugCases = (summary: CaseSummary) => summary.cases.dev.bug + summary.cases.test.bug
      const autoRecord = (summary: CaseSummary) => (auto ? { ...auto, bugCasesAfter: bugCases(summary) } : null)
      // Nothing to label (target reached, no credit, no room under the IU line).
      if (!plan || !input.yes || (auto !== null && auto.state !== 'labelled')) {
        return {
          ...base,
          auto: autoRecord(mined.summary),
          spent: false,
          labelledThisRun: 0,
          stopped: null,
          summary: mined.summary,
        }
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
      if (labelled.stopped !== null) {
        // The run is a success (what was labelled is kept); the stop is a warning so it does not pass unseen.
        warn(`labelling stopped: ${labelled.stopped} (${labelled.labelled} candidates labelled in this run)`, {
          runId: ctx.runId,
        })
      }
      const summary = await ctx.step('cases', () => {
        const rebuilt = rebuildCases({ env, warn, versions: VERSIONS })
        writeReport(report(mined.funnel, rebuilt, now()), env)
        return rebuilt
      })
      return {
        ...base,
        auto: autoRecord(summary),
        spent: true,
        labelledThisRun: labelled.labelled,
        stopped: labelled.stopped,
        summary,
      }
    },
  })
  return {
    workflow,
    summary:
      'Mine the review ground truth from the owner’s fix history; --label N --yes labels N candidates on two vendors (spends); --auto sizes that N from the eval credit and the IU line',
    cli: { positional: ['suite'], defaultFormat: 'json', mutating: true },
  }
}

type AutoSized = Omit<AutoRecord, 'bugCasesAfter'>

/**
 * `--auto`: how many candidates this run labels, and the reasons, from the bug-case count, the gateway's eval credit
 * and the running IU total. At the target nothing else is read. A read that fails fails the step with its reason.
 */
async function sizeAuto(args: {
  input: z.infer<typeof evalMineInput>
  ports: AutoPorts | undefined
  summary: CaseSummary
  env: Record<string, string | undefined>
  warn: Warn
  seed: number
  relabelErrors: boolean
}): Promise<AutoSized> {
  const { input, ports, summary } = args
  const target = input.target ?? AUTO_DEFAULTS.target
  const iuLineUsd = input.iuLineUsd ?? AUTO_DEFAULTS.iuLineUsd
  const bugCasesBefore = summary.cases.dev.bug + summary.cases.test.bug
  const record = { target, bugCasesBefore, iuLineUsd }
  if (bugCasesBefore >= target) {
    return {
      ...record,
      state: 'target-reached',
      creditAvailableUsd: null,
      creditPerCandidateUsd: null,
      iuSpentUsd: null,
      iuPerCandidateUsd: null,
      planned: 0,
    }
  }
  if (!ports) {
    throw new WorkflowError(
      'error',
      '--auto needs the host’s spend reads (gateway credit, usage.records); none is wired',
    )
  }
  const read = async <T>(what: string, call: () => Promise<T>) => {
    try {
      return await call()
    } catch (error) {
      throw new WorkflowError(
        'error',
        `--auto cannot size the run: ${what}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const creditAvailableUsd = await read('eval credit', () => ports.creditAvailableUsd())
  const iuSpentUsd = await read('IU eval spend', () =>
    ports.iuSpentUsd({ since: input.iuSince ?? AUTO_DEFAULTS.iuSince }),
  )
  const history = await read('per-candidate cost history', () => ports.runSpend({ limit: ESTIMATE_HISTORY }))
  const perCandidate = perCandidateCosts(history)

  const all = readRecords('candidates.jsonl', GtCandidate, args.env, args.warn)
  const labels = latestLabels(args.env, VERSIONS, args.warn)
  const unlabelled = pending(all, labels, { seed: args.seed, relabelErrors: args.relabelErrors }).length
  const sized = sizeRun({
    creditAvailableUsd,
    iuSpentUsd,
    iuLineUsd,
    iuMarginUsd: input.iuMarginUsd ?? AUTO_DEFAULTS.iuMarginUsd,
    perCandidate,
    unlabelled,
    maxPerRun: input.maxPerRun ?? AUTO_DEFAULTS.maxPerRun,
  })
  if (sized.state === 'labelled' && sized.planned === 0) {
    // A plan of nothing is never a finished job. With candidates left it is a sizing bug: say so instead of logging a quiet night.
    if (unlabelled > 0) {
      throw new WorkflowError(
        'error',
        `--auto planned 0 candidates with ${unlabelled} unlabelled left; it must label or say why not`,
      )
    }
    // Every candidate is labelled and the target is not reached: the history cannot yield it.
    throw new WorkflowError(
      'error',
      `no unlabelled candidates are left and ${bugCasesBefore} bug cases of ${target} is all the history yields`,
    )
  }
  return {
    ...record,
    ...sized,
    creditAvailableUsd,
    creditPerCandidateUsd: perCandidate.creditUsd,
    iuSpentUsd,
    iuPerCandidateUsd: perCandidate.iuUsd,
  }
}

/**
 * The mean cost of labelling one candidate: the `label` step cost of the latest runs that labelled, over the records
 * they wrote to `labels.jsonl` (every record, whatever its labeler version: the step paid for it). A candidate's cost
 * already covers both labeller calls. Unknown (null) without a history port, a priced step, or a matching record.
 */
async function labelEstimate(
  history: CostHistory | undefined,
  env: Record<string, string | undefined>,
  warn: Warn,
): Promise<{ runs: number; meanCost: number | null }> {
  if (!history) return { runs: 0, meanCost: null }
  // A candidate counts once per run, whatever number of lines it has: a relabelled error appends the record again.
  const candidatesByRun = new Map<string, Set<string>>()
  for (const record of readRecords('labels.jsonl', GtLabelRecord, env, warn)) {
    const seen = candidatesByRun.get(record.runId) ?? new Set<string>()
    seen.add(record.candidateId)
    candidatesByRun.set(record.runId, seen)
  }
  const labelsByRun = new Map([...candidatesByRun].map(([runId, ids]) => [runId, ids.size]))
  const costs = await history.labelStepCosts({ runIds: [...labelsByRun.keys()], limit: ESTIMATE_HISTORY })
  const priced = costs.filter((step) => labelsByRun.has(step.runId))
  const candidates = priced.reduce((sum, step) => sum + (labelsByRun.get(step.runId) ?? 0), 0)
  if (priced.length === 0 || candidates === 0) return { runs: 0, meanCost: null }
  return { runs: priced.length, meanCost: priced.reduce((sum, step) => sum + step.cost, 0) / candidates }
}

/** `report.json`: aggregates only, the input of the committed report. */
function report(funnel: Record<string, number>, summary: CaseSummary, at: Date) {
  return {
    at: at.toISOString(),
    minerVersion: MINER_VERSION,
    labelerVersion: LABELER_VERSION,
    limit: GT_LIMIT,
    funnel,
    labelled: summary.labelled,
    accepted: summary.accepted,
    acceptanceRate: summary.labelled ? summary.accepted / summary.labelled : null,
    acceptPaths: summary.acceptPaths,
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
 * resumed run counts the records it already wrote (by run id) against `wanted`. Stops taking work at the first failure
 * that is not a seat answer. Those in flight always finish and keep their records, an abort or a failed write
 * included, before the failure is rethrown.
 */
async function runLabelling(job: Labelling): Promise<{ labelled: number; stopped: string | null }> {
  const labels = latestLabels(job.env, VERSIONS, job.warn)
  const candidates = readRecords('candidates.jsonl', GtCandidate, job.env, job.warn)
  const done = [...labels.values()].filter((r) => r.runId === job.runId).length
  const queue = pending(candidates, labels, job).slice(0, Math.max(0, job.wanted - done))
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
