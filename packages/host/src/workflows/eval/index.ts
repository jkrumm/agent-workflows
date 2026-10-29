import type { AnyWorkflow, Logger, Runtime } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { createEvalCompare } from './compare.ts'
import { DriftJob, driftOptionsFromEnv } from './drift.ts'
import { createEvalRun, type EvalRunOptions, sweepCaseTrees } from './run.ts'
import { type EvalRuntime, EvalSlot } from './slot.ts'
import type { Suites } from './suites.ts'

export { EVAL_COMPARE_ID } from './compare.ts'
export { DEFAULT_DRIFT, DriftJob, type DriftOptions, type DriftTick, driftOptionsFromEnv } from './drift.ts'
export { caseTreeDir, EVAL_RUN_ID, sweepCaseTrees } from './run.ts'

/** A case tree older than this whose run ended (or never existed) is leftover. */
const SWEEP_AFTER_MS = 3 * 3_600_000
const SWEEP_INTERVAL_MS = 3_600_000

/** Which slot an eval workflow reads: set by `createEvalWorkflows`, found again by `wireEval`. */
const slots = new WeakMap<AnyWorkflow, EvalSlot>()

/** `agw eval run` and `agw eval compare` (concept §6). They need the runtime, which exists after them: `wireEval`. */
export function createEvalWorkflows(suites: Suites, options: EvalRunOptions = {}): HostWorkflow[] {
  const slot = new EvalSlot()
  const entries = [createEvalRun(slot, suites, options), createEvalCompare(slot, suites)]
  for (const entry of entries) slots.set(entry.workflow, slot)
  return entries
}

export interface EvalWiring {
  /** Starts the drift job; call after `runtime.open()`. */
  start(): void
  /** Stops the drift job and waits for its tick; call before `runtime.close()`. */
  close(): Promise<void>
  /** Sweeps leftover case trees now; while a sweep runs, returns that one instead of starting another. */
  sweep(): Promise<void>
}

/**
 * Binds the eval workflows among `workflows` to the runtime (before `runtime.open()`: recovery may resume an eval run
 * at once) with the workflows they replay, and builds the drift job (`AGW_DRIFT_RATE`, `AGW_DRIFT_INTERVAL_S`).
 */
export function wireEval(options: {
  runtime: EvalRuntime & Pick<Runtime, 'driftCandidates'>
  workflows: HostWorkflow[]
  env?: Record<string, string | undefined>
  logger?: Logger
}): EvalWiring {
  const logger = options.logger ?? {
    warn: (message, meta) => console.warn(`[agw-eval] ${message}`, meta ?? ''),
    error: (message, meta) => console.error(`[agw-eval] ${message}`, meta ?? ''),
  }
  const roots = new Set<string | undefined>()
  for (const entry of options.workflows) {
    const slot = slots.get(entry.workflow)
    if (!slot) continue
    slot.runtime = options.runtime
    roots.add(slot.tmpRoot)
    for (const other of options.workflows)
      if (other.workflow.scorer) slot.targets.set(other.workflow.id, other.workflow)
  }
  const drift = new DriftJob(options.runtime, driftOptionsFromEnv(options.env ?? process.env), logger)
  // Case trees a cancel past its settle or a killed process left behind: swept at start and every hour, one sweep at
  // a time (a tick while one runs is skipped).
  let sweeping: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const sweep = (): Promise<void> => {
    sweeping ??= Promise.all(
      [...roots].map((tmpRoot) =>
        sweepCaseTrees({
          runtime: options.runtime,
          tmpRoot,
          olderThanMs: SWEEP_AFTER_MS,
          onUnmarked: (dir) => logger.warn('eval: case tree without a marker kept', { dir }),
        }).then((removed) => {
          if (removed.length) logger.warn('eval: swept leftover case trees', { count: removed.length })
        }),
      ),
    )
      .then(() => undefined)
      .catch((error: unknown) => logger.warn('eval: case tree sweep failed', { error: String(error) }))
      .finally(() => {
        sweeping = null
      })
    return sweeping
  }
  return {
    start: () => {
      drift.start()
      if (roots.size === 0) return
      void sweep()
      timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
      timer.unref?.()
    },
    sweep,
    close: async () => {
      clearInterval(timer)
      await sweeping
      await drift.stop()
    },
  }
}
