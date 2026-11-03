import { GT_LIMIT, GtCase, gtPath, type JudgeInput, type JudgeOutput } from '@agent-workflows/eval'
import { type CallContext, defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { ReviewService } from '../../review/index.ts'
import type { OutputFindingValue } from '../../review/schema.ts'
import { readRecords } from '../eval-mine/files.ts'
import { seatAnswer } from '../eval-mine/label.ts'
import { gitClones, type RecallClones } from './clones.ts'
import { judgeModeOf, type ResolvedMode, scoreCase, scorerVersion } from './scorer.ts'
import { CaseResult, RecallSummary, summarize } from './summary.ts'

export const EVAL_RECALL_ID = 'eval.recall'
export const EVAL_RECALL_CASE_ID = 'eval.recall.case'
const POLL_MS = 60_000

/** The two review operations the run uses; the host's review service fits. */
export type RecallReview = Pick<ReviewService, 'request' | 'status' | 'cancel'>

/** The one capability scoring calls; any registry that serves `eval.judge` fits. */
export interface RecallJudge {
  call(id: 'eval.judge', input: JudgeInput, options: CallContext): Promise<JudgeOutput>
}

export interface EvalRecallOptions {
  review: RecallReview
  registry: RecallJudge
  env?: Record<string, string | undefined>
  clones?: RecallClones
  /** Status poll interval while a job is not submitted. Default 60 s. */
  pollMs?: number
  /** Where a skipped torn line of cases.jsonl is reported. Default: the console. */
  warn?: (message: string, meta?: unknown) => void
}

export const evalRecallInput = z
  .object({
    split: z.enum(['dev', 'test']).optional().describe('Only cases of this split (the metric is defined on `test`)'),
    cases: z.string().optional().describe('Comma-separated case ids; an unknown id is an error'),
    kind: z.enum(['bug', 'control', 'all']).optional().describe('Bug cases, clean controls or both, default all'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('At most this many cases, in file order after the other filters'),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(2)
      .optional()
      .describe('Reviews in flight at once, default 1 (the factory holds two reviewer sessions host-wide)'),
  })
  .strict()

export const evalRecallOutput = z.object({
  runId: z.string(),
  limit: z.string().describe('What no one checked: every report of this ground truth states it'),
  judges: z.object({
    mode: z.enum(['single', 'dual']),
    kappa: z.number().nullable(),
    reason: z.string(),
    scorer: z.string(),
  }),
  selected: z.number().int(),
  summary: RecallSummary,
  cases: z.array(CaseResult),
})

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** Cases in file order after the filters; `--cases` names ids and an unknown one is an error. */
export function selectCases(cases: GtCase[], input: z.infer<typeof evalRecallInput>): GtCase[] {
  let picked = cases
  if (input.cases !== undefined) {
    const ids = [
      ...new Set(
        input.cases
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ]
    const byId = new Map(cases.map((c) => [c.id, c]))
    const unknown = ids.filter((id) => !byId.has(id))
    if (unknown.length > 0) throw new WorkflowError('invalid_input', `unknown case ids: ${unknown.join(', ')}`)
    picked = ids.map((id) => byId.get(id) as GtCase)
  }
  if (input.split) picked = picked.filter((c) => c.split === input.split)
  if (input.kind && input.kind !== 'all') picked = picked.filter((c) => c.kind === input.kind)
  return input.limit ? picked.slice(0, input.limit) : picked
}

type Cloned = { ok: true; dir: string } | { ok: false; reason: string }
type Requested = { state: 'requested'; jobId: string; tier: string } | { state: 'unscored'; reason: string }
type Waited =
  | { state: 'submitted'; wallMs: number; account: string | null; tier: string; seat: string | null }
  | { state: 'unscored'; reason: string }
type Scored =
  | {
      state: 'scored'
      findings: CaseResult['findings']
      scores: Record<string, number>
      pass: boolean
    }
  | { state: 'unscored'; reason: string }

const seatLabel = (seat: { model: string; effort: string } | null) => (seat ? `${seat.model}/${seat.effort}` : null)

/** FIFO slots held across a case's steps, so the factory sees at most `size` of this run's reviews at once. */
export class Gate {
  private free: number
  private readonly waiting: (() => void)[] = []
  constructor(size: number) {
    this.free = size
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.free === 0) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        // A waiter that aborts leaves the queue, or a release would wake it and the slot would be lost.
        const onAbort = () => {
          const at = this.waiting.indexOf(wake)
          if (at >= 0) this.waiting.splice(at, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(wake)
      })
    } else this.free--
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next()
      else this.free++
    }
  }
}

const caseInput = z
  .object({
    evalRunId: z.string(),
    caseId: z.string(),
    mode: z.enum(['single', 'dual']),
    kappa: z.number().nullable(),
    reason: z.string(),
  })
  .strict()

/**
 * `agw eval recall`: the Wave 8 ground-truth cases through review v4's hidden transport, scored by the judge. Each case
 * is a child run (`eval.recall.case`) with the steps: an isolated clone at the case's sha (no refs, origin or
 * alternates, so neither the fix nor a prior finding is reachable), `review.request` on `<parent>..<sha>` with the
 * commit subject as the only context (never the bug description) at `min: light`, a poll until the job is submitted or
 * abandoned (no wall-clock ceiling: the factory paces the session by its quota ceiling and may hold it for hours), the
 * judge's scoring, and the clone's removal. The children wait for a slot (`concurrency`, default 1) before their first
 * step, in file order. A job that did not submit is `unscored` with its reason, not a miss. A resumed request step
 * adopts the case's live job rather than requesting twice. Reviews run on the Max subscriptions; only the judge draws
 * on eval credit.
 */
export function createEvalRecall(options: EvalRecallOptions): HostWorkflow[] {
  const env = options.env ?? process.env
  const clones = options.clones ?? gitClones({ env })
  const pollMs = options.pollMs ?? POLL_MS
  const warn =
    options.warn ?? ((message: string, meta?: unknown) => console.warn(`[agw-eval-recall] ${message}`, meta ?? ''))
  // One gate for the process: the workflow runs one at a time, and its children share the slots of the run.
  let gate = new Gate(1)

  const caseRun = defineWorkflow({
    id: EVAL_RECALL_CASE_ID,
    version: '2026-11-03.1',
    input: caseInput,
    output: CaseResult,
    async run(ctx, input) {
      const release = await gate.acquire(ctx.signal)
      try {
        const reference = readRecords('cases.jsonl', GtCase, env, warn).find((c) => c.id === input.caseId)
        if (!reference) throw new WorkflowError('error', `case ${input.caseId} is no longer in cases.jsonl`)
        const mode: ResolvedMode = { mode: input.mode, kappa: input.kappa, reason: input.reason }
        const head = { id: reference.id, split: reference.split, kind: reference.kind }
        const unscored = (reason: string, rest: Partial<CaseResult> = {}): CaseResult => ({
          ...head,
          status: 'unscored',
          reason,
          tier: null,
          seat: null,
          account: null,
          wallMs: null,
          findings: [],
          scores: null,
          pass: null,
          ...rest,
        })

        const cloned = await ctx.step('clone', async (): Promise<Cloned> => {
          const made = await clones.create(reference)
          return made.ok ? { ok: true, dir: made.dir } : { ok: false, reason: made.reason }
        })
        if (!cloned.ok) return unscored(`clone: ${cloned.reason}`)
        const { dir } = cloned
        const finish = async (result: CaseResult) => {
          await ctx.step('cleanup', () => {
            clones.remove(dir)
            return true
          })
          return result
        }

        const requested = await ctx.step('request', async (): Promise<Requested> => {
          // A resumed step must not request twice: the clone has one repo identity, so its live job is this case's.
          const recent = await options.review.status({ cwd: dir })
          const live = recent.jobs?.find((job) => job.state !== 'abandoned' && job.transport === 'hidden')
          if (live) return { state: 'requested', jobId: live.id, tier: live.tier }
          const asked = await options.review.request({
            cwd: dir,
            scope: `${reference.parent}..${reference.sha}`,
            context: reference.subject,
            min: 'light',
            thread: `eval:${input.evalRunId}:${reference.id}`,
          })
          if (asked.status === 'requested' && asked.jobId && asked.tier)
            return { state: 'requested', jobId: asked.jobId, tier: asked.tier }
          return {
            state: 'unscored',
            reason:
              asked.status === 'needs-human'
                ? `needs-human: ${asked.reason ?? 'a 4th round'}`
                : `request ${asked.status}`,
          }
        })
        if (requested.state === 'unscored') return finish(unscored(requested.reason))

        const waited = await ctx.step('wait', async ({ signal, progress }): Promise<Waited> => {
          for (;;) {
            signal.throwIfAborted()
            const { job } = await options.review.status({ jobId: requested.jobId })
            if (!job) throw new WorkflowError('error', `review job ${requested.jobId} has no status`)
            if (job.state === 'abandoned') return { state: 'unscored', reason: 'abandoned' }
            if (job.hidden?.gaveUp) {
              // The factory ended its retry: nothing will submit. Cancel abandons the job; a spawn that is
              // somehow alive again answers `running` and the poll goes on.
              const last = job.hidden.attempts.at(-1)
              try {
                const cancelled = await options.review.cancel({ jobId: requested.jobId })
                if (cancelled.status !== 'running')
                  return { state: 'unscored', reason: `review gave up: ${last?.status ?? 'unknown'}` }
              } catch (error) {
                // Cancel refuses a job that is no longer prepared (submitted meanwhile): read it again.
                const again = await options.review.status({ jobId: requested.jobId })
                if (again.job?.state === 'prepared') throw error
                continue
              }
            }
            if (job.state === 'submitted') {
              const wallMs = Date.parse(job.submittedAt ?? '') - Date.parse(job.createdAt)
              return {
                state: 'submitted',
                wallMs: Number.isFinite(wallMs) ? Math.max(0, wallMs) : 0,
                account: job.account,
                tier: job.tier,
                seat: seatLabel(job.seat),
              }
            }
            progress()
            await sleep(pollMs, signal)
          }
        })
        if (waited.state === 'unscored') return finish(unscored(waited.reason, { tier: requested.tier }))

        const scored = await ctx.step('score', async ({ callContext }): Promise<Scored> => {
          const { job } = await options.review.status({ jobId: requested.jobId })
          if (!job?.output)
            throw new WorkflowError('error', `review job ${requested.jobId} is submitted without an output`)
          const findings: readonly OutputFindingValue[] = job.output.findings
          try {
            const verdict = await scoreCase({
              reference,
              findings,
              mode,
              diff: await clones.diff(dir, reference.sha),
              judge: (judgeInput) => options.registry.call('eval.judge', judgeInput, callContext),
            })
            return {
              state: 'scored',
              scores: verdict.scores,
              pass: verdict.pass,
              findings: findings.map((f) => ({
                id: f.id,
                tag: f.tag,
                file: f.file,
                line: f.line,
                class: verdict.classes[f.id] ?? 'unclear',
              })),
            }
          } catch (error) {
            // An unusable judge answer is about this case; an outage or a missing credit is not, and fails the step.
            const answer = seatAnswer(error)
            if (answer === null) throw error
            return { state: 'unscored', reason: `judge: ${answer}` }
          }
        })
        const common = { tier: waited.tier, seat: waited.seat, account: waited.account, wallMs: waited.wallMs }
        return finish(
          scored.state === 'scored'
            ? {
                ...head,
                status: 'scored',
                reason: null,
                ...common,
                findings: scored.findings,
                scores: scored.scores,
                pass: scored.pass,
              }
            : unscored(scored.reason, common),
        )
      } finally {
        release()
      }
    },
  })

  const recall = defineWorkflow({
    id: EVAL_RECALL_ID,
    version: '2026-11-03.1',
    // One run at a time: the factory holds two reviewer sessions host-wide.
    concurrency: 1,
    input: evalRecallInput,
    output: evalRecallOutput,
    async run(ctx, input) {
      const all = readRecords('cases.jsonl', GtCase, env, warn)
      const plan = await ctx.step('plan', () => {
        const ids = selectCases(all, input).map((c) => c.id)
        if (ids.length === 0)
          throw new WorkflowError('invalid_input', `no case matches the filters in ${gtPath('cases.jsonl', env)}`)
        const mode = judgeModeOf(env)
        return { ids, mode: mode.mode, kappa: mode.kappa, reason: mode.reason }
      })
      gate = new Gate(input.concurrency ?? 1)
      const done = await ctx.workflow(
        'cases',
        caseRun,
        plan.ids.map((caseId) => ({
          evalRunId: ctx.runId,
          caseId,
          mode: plan.mode,
          kappa: plan.kappa,
          reason: plan.reason,
        })),
      )
      // A cancelled run ends cancelled: its children came back empty because of it.
      ctx.signal.throwIfAborted()
      const byId = new Map(all.map((c) => [c.id, c]))
      const results = plan.ids.map((id, i): CaseResult => {
        const result = done[i]
        if (result) return result
        const reference = byId.get(id)
        return {
          id,
          split: reference?.split ?? 'dev',
          kind: reference?.kind ?? 'bug',
          status: 'unscored',
          reason: 'case run failed (see its run record)',
          tier: null,
          seat: null,
          account: null,
          wallMs: null,
          findings: [],
          scores: null,
          pass: null,
        }
      })
      return {
        runId: ctx.runId,
        limit: GT_LIMIT,
        judges: { mode: plan.mode, kappa: plan.kappa, reason: plan.reason, scorer: scorerVersion(plan.mode) },
        selected: plan.ids.length,
        summary: summarize(results),
        cases: results,
      }
    },
  })
  return [
    {
      workflow: recall,
      summary:
        'Run ground-truth cases through review v4’s hidden transport (one Max reviewer session per case, paced by the factory) and score recall, false alarms and noise with the judge',
      cli: { defaultFormat: 'json', mutating: true },
    },
    { workflow: caseRun, internal: true },
  ]
}
