import { capDiff, parseJsonLoose } from '@agent-workflows/capabilities'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import { isBalanceFailure } from '@agent-workflows/routes'
import { type AgentSpec, type Ctx, defineWorkflow, StepFailed, WorkflowError } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { gatedAngles, requestedAngles, resolveDepth, routerPicks, selectFloor } from './angles.ts'
import { createExec } from './exec.ts'
import { type Prepared, prepare, type ReviewPorts, removeClone, restoreClone } from './git.ts'
import { createOcrWorkflow, OCR_WORKFLOW_ID } from './ocr.ts'
import { renderAngleBlock, renderFallowBlock, SYNTHESIS_JSON_ONLY_RETRY, angleTask, synthesisTask } from './prompts.ts'
import { renderReactDoctorBlock, type ReactDoctorRaw, runReactDoctor } from './react-doctor.ts'
import {
  ALL_ANGLES,
  type Angle,
  AngleOutput,
  type AngleResult,
  ReviewInput,
  ReviewOutput,
  type ReviewResult,
  SynthesisOutput,
} from './schema.ts'
import {
  allFailedVerdict,
  applyVerdictRules,
  balanceDegradedVerdict,
  balanceSalvagedVerdict,
  cleanVerdict,
  coerceEscalationCategory,
  salvagedVerdict,
} from './verdict.ts'
import { z } from 'zod'
import { reviewScorer } from './scorer.ts'
import { mapLimit } from './util.ts'

export const REVIEW_VERSION = '2026-10-29.1'

/** Angle agents in flight at once: more would trip the IU endpoint's rate limits when several fire together. */
export const ANGLE_CONCURRENCY = 3
/** One retry per angle: a single flaky attempt (an idle kill, a malformed final message) must not decide the verdict. */
const ANGLE_ATTEMPTS = 2

export type ReviewOptions = Partial<ReviewPorts> & {
  /** Wait between an angle's two attempts. Default 1 s. */
  angleBackoffMs?: number
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string }

/** A failed step as a value, so the pipeline can go on without it; every other error (cancel, shutdown) still unwinds. */
async function settle<T>(step: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await step }
  } catch (error) {
    if (error instanceof StepFailed) return { ok: false, reason: error.reason }
    throw error
  }
}

type AngleSpec = AgentSpec<typeof AngleOutput>

/**
 * One literal step id per angle (`angle:<name>`): a computed id would silently make a new step on replay
 * (`runtime/test/step-id-literal.test.ts`). The table is the fan-out's only branch.
 */
const ANGLE_STEP: Record<Angle, (ctx: Ctx, spec: AngleSpec) => Promise<z.output<typeof AngleOutput>>> = {
  architect: (ctx, spec) => ctx.agent('angle:architect', spec),
  'senior-dev': (ctx, spec) => ctx.agent('angle:senior-dev', spec),
  frontend: (ctx, spec) => ctx.agent('angle:frontend', spec),
  backend: (ctx, spec) => ctx.agent('angle:backend', spec),
  typescript: (ctx, spec) => ctx.agent('angle:typescript', spec),
  qa: (ctx, spec) => ctx.agent('angle:qa', spec),
  security: (ctx, spec) => ctx.agent('angle:security', spec),
  performance: (ctx, spec) => ctx.agent('angle:performance', spec),
  concurrency: (ctx, spec) => ctx.agent('angle:concurrency', spec),
  'data-migration': (ctx, spec) => ctx.agent('angle:data-migration', spec),
  'api-contract': (ctx, spec) => ctx.agent('angle:api-contract', spec),
  resilience: (ctx, spec) => ctx.agent('angle:resilience', spec),
}

const normalize = (findings: z.output<typeof AngleOutput>['findings']): AngleResult['findings'] =>
  findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line ?? null, message: f.message }))

/** The route every angle runs on; a review the caller asked to run at `deep` runs them on `ANGLE_DEEP_ROUTE` (Sonnet), set per step. */
const ANGLE_ROUTE = 'review.angle' as const
const ANGLE_DEEP_ROUTE = 'review.angle.deep' as const

/**
 * The agents of the run fingerprint: every `review-*` definition under `agents/`, with the route it runs on. The
 * fingerprint is taken at admission, before the router decides the depth, so each angle is listed on both of its routes:
 * a change to either (an override included) changes the fingerprint of every review.
 */
const AGENTS = [
  ...ALL_ANGLES.flatMap((angle) =>
    [ANGLE_ROUTE, ANGLE_DEEP_ROUTE].map((route) => ({ agent: `review-${angle}`, route })),
  ),
  { agent: 'review-synthesis', route: 'review.synthesis' as const },
  { agent: 'review-router', route: 'review.router' as const },
  { agent: 'review-adversary', route: 'review.adversary' as const },
]

const SynthesisSchema = z.preprocess((raw) => dropNullLines(coerceEscalationCategory(raw)), SynthesisOutput)

/** A model's `"line": null` is "not identifiable", the same as an absent line. */
function dropNullLines(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const out: Record<string, unknown> = { ...raw }
  for (const key of ['blocking', 'improvements', 'discussions']) {
    const list = out[key]
    if (!Array.isArray(list)) continue
    out[key] = list.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('line' in entry) || entry.line !== null) return entry
      const { line: _line, ...rest } = entry as Record<string, unknown>
      return rest
    })
  }
  return out
}

function parseSynthesis(text: string) {
  const parsed = parseJsonLoose(text)
  return parsed === null ? null : SynthesisSchema.safeParse(parsed)
}

/** A step's failure reason that is a provider-balance refusal (the transports' and the OpenCode host's wording). */
const onBalance = (reason: string | null) => reason !== null && isBalanceFailure({ text: reason })

/** Why OCR does not run for this review, or null when it should. Every gate decides whether, none truncates a run. */
export function ocrSkipReason(p: Prepared, depth: string): string | null {
  if (!p.ocrEnabled) return 'AGW_REVIEW_OCR=0'
  if (p.gating && depth !== 'deep') return `review depth ${depth}; AGW_REVIEW_DEPTH_GATING`
  if (p.changedLines < p.ocrMinLines)
    return `diff has ${p.changedLines} changed lines, below the ${p.ocrMinLines}-line gate`
  if (p.ocrBlocker) return p.ocrBlocker
  if (!p.ocr) return 'scope is a file path, which ocr has no equivalent mode for'
  return null
}

export function createReviewWorkflows(deps: WorkflowDeps, options: ReviewOptions = {}): HostWorkflow[] {
  const { angleBackoffMs = 1_000, ...given } = options
  const env = given.env ?? process.env
  const ports: ReviewPorts = {
    exec: createExec(env),
    which: (bin) => Bun.which(bin),
    env,
    stateDir: DEFAULT_STATE_DIR,
    now: Date.now,
    ...given,
  }
  const { registry } = deps
  const ocr = createOcrWorkflow(ports)

  async function runPipeline(
    ctx: Ctx,
    input: z.output<typeof ReviewInput>,
    p: Prepared,
    pending: Promise<unknown>[],
  ): Promise<ReviewResult> {
    if (!p.diff.trim()) return cleanVerdict('No changes to review.')
    const { repo, diff } = p
    const context = input.context
    // Whatever runs beside the pipeline is awaited by the caller's cleanup before the clone goes, and a rejection nobody
    // reads yet is still handled, so a failing sibling never becomes an unhandled rejection.
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.push(promise)
      promise.catch(() => {})
      return promise
    }

    // Started now, awaited at synthesis: their wall time hides behind the router and the angles.
    const reactDoctor = track(
      settle(ctx.step('react-doctor', () => runReactDoctor(ports, repo, p.base))).then(
        (r): ReactDoctorRaw => (r.ok ? r.value : { stdout: `react-doctor failed: ${r.reason}`, ok: true }),
      ),
    )
    const adversary: Promise<AngleResult> | null = p.adversary
      ? track(
          settle(
            ctx.step('adversary', async ({ addUsage, signal }): Promise<AngleResult> => {
              const out = await registry.call(
                'review.adversary',
                { diff, ...(context ? { context } : {}) },
                { addUsage, signal },
              )
              return { angle: 'adversary', findings: normalize(out.findings), failureReason: null }
            }),
          ).then((r) => (r.ok ? r.value : { angle: 'adversary', findings: [], failureReason: r.reason })),
        )
      : null

    const explicit = (input.angles?.length ?? 0) > 0
    const routed = explicit
      ? null
      : await settle(
          ctx.step('route', async ({ addUsage, signal }) => {
            const out = await registry.call('review.route', { diff }, { addUsage, signal })
            return { angles: out.angles, depth: out.depth ?? null, depthReason: out.depthReason ?? null }
          }),
        )
    // A router failure adds no angles and no depth: the floor still reviews.
    const router = routed?.ok ? routed.value : null
    const decision = resolveDepth(input.depth, router)
    const angles = explicit
      ? requestedAngles(input.angles ?? [])
      : gatedAngles(decision.depth, p.gating, selectFloor(p.files, p.hasTestScript), routerPicks(router?.angles ?? []))
    // Opt-in: only the caller's `deep` moves the angles to Sonnet (about 10x the spend); a router-chosen deep does not.
    const angleRoute = decision.source === 'caller' && decision.depth === 'deep' ? ANGLE_DEEP_ROUTE : ANGLE_ROUTE
    const skip = ocrSkipReason(p, decision.depth)
    await ctx.step('plan', () => ({
      depth: decision.depth,
      depthSource: decision.source,
      depthReason: decision.reason,
      gating: p.gating,
      angles,
      angleRoute,
      routerFailed: routed !== null && !routed.ok,
      changedLines: p.changedLines,
      ocr: skip === null ? 'run' : `skipped: ${skip}`,
    }))

    // OCR as a child run: the wallet gate may refuse it at admission, and a refused or failed child is a null here,
    // never a failed review.
    const ocrRun =
      skip === null && p.ocr
        ? track(
            settle(
              ctx.workflow('ocr', ocr.workflow, [
                {
                  cwd: repo,
                  mode: p.ocr.mode,
                  ...(p.ocr.from ? { from: p.ocr.from } : {}),
                  ...(p.ocr.to ? { to: p.ocr.to } : {}),
                  ...(context ? { context } : {}),
                },
              ]),
            ),
          )
        : null

    const task = angleTask({ repo, label: p.label, files: p.files, context, diff, invokedIn: p.invokedIn })
    const runAngle = async (angle: Angle): Promise<AngleResult> => {
      const spec: AngleSpec = {
        agent: `review-${angle}`,
        prompt: task,
        output: AngleOutput,
        options: { output: 'json', allowDirectories: [repo], route: angleRoute },
        retry: { attempts: ANGLE_ATTEMPTS, backoffMs: angleBackoffMs },
      }
      const result = await settle(ANGLE_STEP[angle](ctx, spec))
      return result.ok
        ? { angle, findings: normalize(result.value.findings), failureReason: null }
        : { angle, findings: [], failureReason: result.reason }
    }
    const [angleResults, adversaryResult] = await Promise.all([
      track(mapLimit(angles, ANGLE_CONCURRENCY, runAngle)),
      adversary,
    ])
    const results = adversaryResult ? [...angleResults, adversaryResult] : angleResults
    const failed = results.filter((r) => r.failureReason !== null)
    const total = results.length

    // Every reviewer failed: a synthesis of nothing would read as approval. All of them on provider balance (after
    // their routes' fallbacks) is the typed degrade: the caller reviews in-session.
    // The verdict does not wait for OCR or react-doctor: the runtime has no way to cancel a sibling step, so the cleanup
    // path awaits them (no clone is removed under a running helper), not this answer.
    if (failed.length === total) {
      return failed.every((r) => onBalance(r.failureReason))
        ? balanceDegradedVerdict(failed)
        : allFailedVerdict(failed, total)
    }

    const ocrOutcome = ocrRun ? await ocrRun : null
    const ocrBlock = !ocrRun
      ? `OpenCodeReview: skipped (${skip})`
      : ocrOutcome?.ok && ocrOutcome.value[0]
        ? ocrOutcome.value[0].block
        : 'OpenCodeReview: skipped (the OCR run was refused at admission or failed; no OCR input for this review)'
    const prompt = synthesisTask({
      repo,
      angles: renderAngleBlock(results),
      fallow: renderFallowBlock(p.fallow),
      reactDoctor: renderReactDoctorBlock(await reactDoctor),
      ocr: ocrBlock,
      invokedIn: p.invokedIn,
      diffTruncated: capDiff(diff).truncatedChars > 0,
    })

    // The synthesis answers as text and is parsed here, so a refusal to return JSON keeps the raw text for the salvage.
    const synthesisSpec = (text: string): AgentSpec<z.ZodString> => ({
      agent: 'review-synthesis',
      prompt: text,
      output: z.string(),
      options: { output: 'text', allowDirectories: [repo] },
    })
    const attempt = (answer: Settled<string>) =>
      answer.ok
        ? { text: answer.value, reason: null, parsed: parseSynthesis(answer.value) }
        : { text: null, reason: answer.reason, parsed: null }
    const first = attempt(await settle(ctx.agent('synthesis', synthesisSpec(prompt))))
    let synthesis = first
    // A synthesis refused on provider balance (its fallback included) is not re-asked: the retry is for a bad answer.
    if (!first.parsed?.success && !(first.text === null && onBalance(first.reason))) {
      synthesis = attempt(await settle(ctx.agent('synthesis-retry', synthesisSpec(prompt + SYNTHESIS_JSON_ONLY_RETRY))))
    }
    // No synthesis text at all and the last refusal was balance: the reviewers ran (an all-failed run ended above), so
    // their findings are salvaged with the degrade.
    if (!first.text && !synthesis.text && onBalance(synthesis.reason)) {
      return balanceSalvagedVerdict(renderAngleBlock(results), failed, total)
    }
    if (!synthesis.parsed?.success) {
      // The raw text of the last attempt that produced any; a session that died says why only when none did.
      const raw = [synthesis.text, first.text].find((t) => t?.trim()) ?? synthesis.reason ?? first.reason ?? ''
      return salvagedVerdict(raw, failed, total)
    }

    // The outcome is derived from the lists here, never trusted from the model.
    const { verdict } = applyVerdictRules(synthesis.parsed.data, failed, total)
    return { ...verdict, schemaVersion: 2 }
  }

  const review = defineWorkflow({
    id: 'review',
    version: REVIEW_VERSION,
    input: ReviewInput,
    output: ReviewOutput,
    scorer: reviewScorer,
    async run(ctx, input) {
      const prepared = await ctx.step('prepare', (scope) => prepare(input, scope.key, ports))
      if (!prepared.ok) throw new WorkflowError(prepared.kind, prepared.message)
      // A clone a sweep removed since `prepare` ran is rebuilt at the same path before any step reads it.
      const gone = await restoreClone(ports, prepared, input, `${ctx.runId}:prepare`)
      if (gone) throw new WorkflowError('error', gone)
      const pending: Promise<unknown>[] = []
      try {
        return await runPipeline(ctx, input, prepared, pending)
      } finally {
        // No helper may still be running in the clone when it is removed.
        await Promise.allSettled(pending)
        // The throwaway clone goes with the run. A cancel or a crash skips this; the next prepare sweeps what is left.
        const { clone } = prepared
        if (clone) {
          await ctx
            .effect('cleanup', () => {
              removeClone(ports, clone)
              return { removed: true }
            })
            .catch(() => {})
        }
      }
    },
  })

  return [
    {
      workflow: review,
      summary: 'Multi-angle code review of a diff: angles, an adversary, optional OCR, one verdict',
      cli: { mutating: false, defaultFormat: 'json' },
      agents: AGENTS,
    },
    ocr,
  ]
}

export { OCR_WORKFLOW_ID }
