import type { CheckCase, ReviewCase } from '../cases.ts'
import type { Exec } from './exec.ts'
import { matchFindings } from './match.ts'
import { cleanup, type Materialized, materialize } from './materialize.ts'
import type { CheckRun, CheckRunner, Judge, Located, ReviewOutput, ReviewRun, ReviewRunner } from './ports.ts'
import {
  appendResult,
  type CheckCaseResult,
  type CheckSide,
  finishedIds,
  type ReviewCaseResult,
  type ReviewSide,
  readResults,
} from './results.ts'

/** The angle agent-gateway (and the new review) give a reviewer that failed: a pipeline discussion. */
export const PIPELINE_ANGLE = '(review pipeline)'

export interface HarnessOptions {
  exec: Exec
  /** The root `case.repo` is relative to (`$HOME`). */
  home: string
  tmpRoot?: string
  concurrency: number
  /** Keep the clones after each case. */
  keep: boolean
  /** `matched`: the new side gets the depth the legacy run recorded; `router`: the new router picks. */
  depthMode: 'matched' | 'router'
  resultsPath: string
  log?: (line: string) => void
}

export interface ReviewPorts {
  next: ReviewRunner
  /** The legacy rerun (`--rerun-legacy`); absent: compare against the recorded run only. */
  legacy?: ReviewRunner
  judge?: Judge
}

export interface CheckPorts {
  next: CheckRunner
  legacy?: CheckRunner
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

/** Runs one call at a time: legacy reruns go serially, so the IU time-window cost match never sees two jobs. */
export function serialLock() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}
type Lock = ReturnType<typeof serialLock>

/** Both sides on the same tree, one after the other; the order alternates per case so neither side always goes first. */
async function bothSides<T>(index: number, next: () => Promise<T>, legacy?: () => Promise<T>) {
  let legacyResult: { ok: true; value: T } | { ok: false; error: string } | undefined
  const runLegacy = async () => {
    if (!legacy) return
    legacyResult = await legacy().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: errorText(error) }),
    )
  }
  if (index % 2 === 1) await runLegacy()
  const nextResult = await next()
  if (index % 2 === 0) await runLegacy()
  return { next: nextResult, legacy: legacyResult }
}

async function withTree<R>(
  options: HarnessOptions,
  input: { repo: string; baseSha: string; patch?: string },
  setup: boolean,
  run: (tree: Extract<Materialized, { ok: true }>) => Promise<R>,
  skipped: (tree: Extract<Materialized, { ok: false }>) => R,
): Promise<R> {
  const tree = await materialize(input, { exec: options.exec, home: options.home, tmpRoot: options.tmpRoot, setup })
  try {
    return tree.ok ? await run(tree) : skipped(tree)
  } finally {
    if (tree.dir && !options.keep) cleanup(tree.dir)
    else if (tree.dir) options.log?.(`kept ${tree.dir}`)
  }
}

function reviewSide(run: ReviewRun): ReviewSide {
  const { output, spend } = run
  return {
    outcome: output.outcome,
    blocking: output.blocking.length,
    improvements: output.improvements.length,
    failedAngles: output.discussions.filter((d) => d.angle === PIPELINE_ANGLE).length,
    costUsd: spend.costUsd,
    costExact: spend.costExact,
    wallMs: spend.wallMs,
    ...(run.runId ? { runId: run.runId } : {}),
  }
}

const blockingOf = (output: ReviewOutput): Located[] =>
  output.blocking.map((f) => ({ file: f.file, line: f.line ?? null, message: f.message }))

export function recordedReviewSide(c: ReviewCase): ReviewSide {
  return {
    outcome: c.legacy.outcome,
    blocking: c.legacy.findings.filter((f) => f.severity === 'blocking').length,
    improvements: c.legacy.findings.filter((f) => f.severity === 'improvement').length,
    failedAngles: c.legacy.failedAngles.length,
    costUsd: c.legacy.costUsd,
    costExact: c.legacy.costExact,
    wallMs: c.legacy.wallMs,
  }
}

/** The depth the new side is asked for: the one the legacy run used, so depth gating compares like for like. */
export const requestedDepth = (c: ReviewCase, mode: HarnessOptions['depthMode']) =>
  mode === 'router' ? null : (c.legacy.depth ?? c.input.depth ?? null)

const reviewBase = (c: ReviewCase, options: HarnessOptions) => ({
  id: c.id,
  workflow: 'review' as const,
  repo: c.repo,
  depth: requestedDepth(c, options.depthMode),
  legacy: recordedReviewSide(c),
})

async function reviewCase(c: ReviewCase, index: number, ports: ReviewPorts, options: HarnessOptions, lock: Lock) {
  const base = reviewBase(c, options)
  const { depth } = base
  return withTree<ReviewCaseResult>(
    options,
    { repo: c.repo, baseSha: c.baseSha, patch: c.diff },
    false,
    async (tree) => {
      const request = {
        cwd: tree.dir,
        ...(depth ? { depth } : {}),
        ...(c.input.context ? { context: c.input.context } : {}),
      }
      // The legacy CLI takes no depth: its rerun is always router-chosen.
      const legacy = ports.legacy
      let sides: Awaited<ReturnType<typeof bothSides<ReviewRun>>>
      try {
        sides = await bothSides(
          index,
          () => ports.next.review(request),
          legacy && (() => lock(() => legacy.review({ cwd: tree.dir }))),
        )
      } catch (error) {
        return { ...base, status: 'error', reason: 'new_failed', detail: errorText(error) }
      }
      const reference: Located[] = c.legacy.findings
        .filter((f) => f.severity === 'blocking')
        .map((f) => ({ file: f.file, line: f.line ?? null, message: f.message }))
      const candidate = blockingOf(sides.next.output)
      const match = await matchFindings(reference, candidate, { judge: ports.judge, diff: c.diff })
      const matchedR = new Set(match.pairs.map(([r]) => r))
      const matchedC = new Set(match.pairs.map(([, cIndex]) => cIndex))
      const result: ReviewCaseResult = {
        ...base,
        status: 'ok',
        new: reviewSide(sides.next),
        match: {
          reference: match.reference,
          matched: match.matched,
          judged: match.judged,
          unsure: match.unsure,
          newOnly: candidate.length - match.matched,
        },
        missed: reference.filter((_, r) => !matchedR.has(r)),
        newOnly: candidate.filter((_, i) => !matchedC.has(i)),
      }
      if (sides.legacy?.ok) {
        const self = await matchFindings(reference, blockingOf(sides.legacy.value.output), {
          judge: ports.judge,
          diff: c.diff,
        })
        result.rerun = {
          ...reviewSide(sides.legacy.value),
          self: { reference: self.reference, matched: self.matched, judged: self.judged, unsure: self.unsure },
        }
      } else if (sides.legacy) result.rerunError = sides.legacy.error
      return result
    },
    (tree) => ({ ...base, status: 'skipped', reason: tree.reason, detail: tree.detail }),
  )
}

function checkSide(run: CheckRun): CheckSide {
  return {
    passed: run.output.passed,
    steps: run.output.steps.map((s) => ({ name: s.name, passed: s.passed })),
    costUsd: run.spend.costUsd,
    costExact: run.spend.costExact,
    wallMs: run.spend.wallMs,
    ...(run.runId ? { runId: run.runId } : {}),
  }
}

export const recordedCheckSide = (c: CheckCase): CheckSide => ({
  passed: c.legacy.passed,
  steps: c.legacy.steps.map((s) => ({ name: s.name, passed: s.passed })),
  costUsd: c.legacy.costUsd,
  costExact: c.legacy.costExact,
  wallMs: c.legacy.wallMs,
})

const checkBase = (c: CheckCase) => ({
  id: c.id,
  workflow: 'check' as const,
  repo: c.repo,
  legacy: recordedCheckSide(c),
})

async function checkCase(c: CheckCase, index: number, ports: CheckPorts, options: HarnessOptions, lock: Lock) {
  const base = checkBase(c)
  return withTree<CheckCaseResult>(
    options,
    { repo: c.repo, baseSha: c.baseSha, patch: c.patch },
    true,
    async (tree) => {
      const request = { cwd: tree.dir, ...(c.input.commands ? { commands: c.input.commands } : {}) }
      const legacy = ports.legacy
      let sides: Awaited<ReturnType<typeof bothSides<CheckRun>>>
      try {
        sides = await bothSides(
          index,
          () => ports.next.check(request),
          legacy && (() => lock(() => legacy.check(request))),
        )
      } catch (error) {
        return { ...base, status: 'error', reason: 'new_failed', detail: errorText(error) }
      }
      const result: CheckCaseResult = { ...base, status: 'ok', new: checkSide(sides.next) }
      if (sides.legacy?.ok) result.rerun = checkSide(sides.legacy.value)
      else if (sides.legacy) result.rerunError = sides.legacy.error
      return result
    },
    (tree) => ({ ...base, status: 'skipped', reason: tree.reason, detail: tree.detail }),
  )
}

/** Cases not yet finished in `resultsPath`; finished ones are skipped, so a run resumes where it stopped. */
function pending<T extends { id: string }>(cases: T[], resultsPath: string): T[] {
  const done = finishedIds(readResults(resultsPath))
  return cases.filter((c) => !done.has(c.id))
}

async function runAll<C extends { id: string }, R extends ReviewCaseResult | CheckCaseResult>(
  cases: C[],
  options: HarnessOptions,
  one: (c: C, index: number) => Promise<R>,
  failed: (c: C, error: unknown) => R,
): Promise<R[]> {
  const todo = pending(cases, options.resultsPath)
  if (todo.length < cases.length) options.log?.(`resume: ${cases.length - todo.length} cases already finished`)
  // The case's position in the full set fixes its side order, so a resumed run alternates as the first did.
  const position = new Map(cases.map((c, index) => [c.id, index]))
  await pool(todo, options.concurrency, async (c) => {
    // A throw anywhere in a case (materialize, the judge, the matcher) is that case's error; the pool keeps going.
    const result = await one(c, position.get(c.id) ?? 0).catch((error: unknown) => failed(c, error))
    appendResult(options.resultsPath, result)
    options.log?.(`${result.status.padEnd(7)} ${c.id}${result.reason ? ` (${result.reason})` : ''}`)
  })
  const ids = new Set(cases.map((c) => c.id))
  return readResults<R>(options.resultsPath).filter((r) => ids.has(r.id))
}

const harnessFailed = (error: unknown) => ({
  status: 'error' as const,
  reason: 'harness_failed' as const,
  detail: errorText(error),
})

export function runReview(cases: ReviewCase[], ports: ReviewPorts, options: HarnessOptions) {
  const lock = serialLock()
  return runAll<ReviewCase, ReviewCaseResult>(
    cases,
    options,
    (c, i) => reviewCase(c, i, ports, options, lock),
    (c, error) => ({ ...reviewBase(c, options), ...harnessFailed(error) }),
  )
}

export function runCheck(cases: CheckCase[], ports: CheckPorts, options: HarnessOptions) {
  const lock = serialLock()
  return runAll<CheckCase, CheckCaseResult>(
    cases,
    options,
    (c, i) => checkCase(c, i, ports, options, lock),
    (c, error) => ({ ...checkBase(c), ...harnessFailed(error) }),
  )
}
