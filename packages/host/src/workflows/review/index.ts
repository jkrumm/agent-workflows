import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import { type AgentSpec, type Ctx, defineWorkflow, StepFailed, WorkflowError } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { gatedAngles, requestedAngles, resolveDepth, routerPicks, selectFloor } from './angles.ts'
import { defaultExec } from './exec.ts'
import { type Prepared, prepare, type ReviewPorts, removeClone } from './git.ts'
import { createOcrWorkflow, OCR_WORKFLOW_ID } from './ocr.ts'
import {
  parseJsonLoose,
  renderAngleBlock,
  renderFallowBlock,
  SYNTHESIS_JSON_ONLY_RETRY,
  angleTask,
  synthesisTask,
} from './prompts.ts'
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
  cleanVerdict,
  coerceEscalationCategory,
  salvagedVerdict,
} from './verdict.ts'
import { z } from 'zod'

export const REVIEW_VERSION = '2026-10-28.1'

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

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i] as T)
      }
    }),
  )
  return out
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

/** The agents of the run fingerprint: every `review-*` definition under `agents/`, with the route it runs on. */
const AGENTS = [
  ...ALL_ANGLES.map((angle) => ({ agent: `review-${angle}`, route: 'review.angle' as const })),
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
  const ports: ReviewPorts = {
    exec: defaultExec,
    which: (bin) => Bun.which(bin),
    env: process.env,
    stateDir: DEFAULT_STATE_DIR,
    now: Date.now,
    ...given,
  }
  const { registry } = deps
  const ocr = createOcrWorkflow(ports)

  async function runPipeline(ctx: Ctx, input: z.output<typeof ReviewInput>, p: Prepared): Promise<ReviewResult> {
    if (!p.diff.trim()) return cleanVerdict('No changes to review.')
    const { repo, diff } = p
    const context = input.context

    // Started now, awaited at synthesis: their wall time hides behind the router and the angles.
    const reactDoctor = settle(ctx.step('react-doctor', () => runReactDoctor(ports, repo, p.base))).then(
      (r): ReactDoctorRaw => (r.ok ? r.value : { stdout: `react-doctor failed: ${r.reason}`, ok: true }),
    )
    const adversary: Promise<AngleResult> | null = p.adversary
      ? settle(
          ctx.step('adversary', async ({ addUsage, signal }): Promise<AngleResult> => {
            const out = await registry.call(
              'review.adversary',
              { diff, ...(context ? { context } : {}) },
              { addUsage, signal },
            )
            return { angle: 'adversary', findings: normalize(out.findings), failureReason: null }
          }),
        ).then((r) => (r.ok ? r.value : { angle: 'adversary', findings: [], failureReason: r.reason }))
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
    const skip = ocrSkipReason(p, decision.depth)
    await ctx.step('plan', () => ({
      depth: decision.depth,
      depthSource: decision.source,
      depthReason: decision.reason,
      gating: p.gating,
      angles,
      routerFailed: routed !== null && !routed.ok,
      changedLines: p.changedLines,
      ocr: skip === null ? 'run' : `skipped: ${skip}`,
    }))

    // OCR as a child run: the wallet gate may refuse it at admission, and a refused or failed child is a null here,
    // never a failed review.
    const ocrRun =
      skip === null && p.ocr
        ? settle(
            ctx.workflow('ocr', ocr.workflow, [
              {
                cwd: repo,
                mode: p.ocr.mode,
                ...(p.ocr.from ? { from: p.ocr.from } : {}),
                ...(p.ocr.to ? { to: p.ocr.to } : {}),
                ...(context ? { context } : {}),
              },
            ]),
          )
        : null

    const task = angleTask({ repo, label: p.label, files: p.files, context, diff })
    const runAngle = async (angle: Angle): Promise<AngleResult> => {
      const spec: AngleSpec = {
        agent: `review-${angle}`,
        prompt: task,
        output: AngleOutput,
        options: { output: 'json', allowDirectories: [repo] },
        retry: { attempts: ANGLE_ATTEMPTS, backoffMs: angleBackoffMs },
      }
      const result = await settle(ANGLE_STEP[angle](ctx, spec))
      return result.ok
        ? { angle, findings: normalize(result.value.findings), failureReason: null }
        : { angle, findings: [], failureReason: result.reason }
    }
    const [angleResults, adversaryResult] = await Promise.all([
      mapLimit(angles, ANGLE_CONCURRENCY, runAngle),
      adversary,
    ])
    const results = adversaryResult ? [...angleResults, adversaryResult] : angleResults
    const failed = results.filter((r) => r.failureReason !== null)
    const total = results.length

    // Every reviewer failed: a synthesis of nothing would read as approval.
    if (failed.length === total) {
      await Promise.all([ocrRun, reactDoctor])
      return allFailedVerdict(failed, total)
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
    })

    // The synthesis answers as text and is parsed here, so a refusal to return JSON keeps the raw text for the salvage.
    const synthesisSpec = (text: string): AgentSpec<z.ZodString> => ({
      agent: 'review-synthesis',
      prompt: text,
      output: z.string(),
      options: { output: 'text', allowDirectories: [repo] },
    })
    const attempt = (answer: Settled<string>) => {
      if (!answer.ok) return { raw: answer.reason, parsed: null }
      return { raw: answer.value, parsed: parseSynthesis(answer.value) }
    }
    let synthesis = attempt(await settle(ctx.agent('synthesis', synthesisSpec(prompt))))
    if (!synthesis.parsed?.success) {
      synthesis = attempt(await settle(ctx.agent('synthesis-retry', synthesisSpec(prompt + SYNTHESIS_JSON_ONLY_RETRY))))
    }
    if (!synthesis.parsed?.success) return salvagedVerdict(synthesis.raw, total)

    // The outcome is derived from the lists here, never trusted from the model.
    const { verdict } = applyVerdictRules(synthesis.parsed.data, failed, total)
    return { ...verdict, schemaVersion: 2 }
  }

  const review = defineWorkflow({
    id: 'review',
    version: REVIEW_VERSION,
    input: ReviewInput,
    output: ReviewOutput,
    async run(ctx, input) {
      const prepared = await ctx.step('prepare', (scope) => prepare(input, scope.key, ports))
      if (!prepared.ok) throw new WorkflowError(prepared.kind, prepared.message)
      try {
        return await runPipeline(ctx, input, prepared)
      } finally {
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
