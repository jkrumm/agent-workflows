import type { AnyWorkflow, Logger, Runtime } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { createEvalCompare } from './compare.ts'
import { DriftJob, driftOptionsFromEnv } from './drift.ts'
import { createEvalRun, type EvalRunOptions } from './run.ts'
import { type EvalRuntime, EvalSlot } from './slot.ts'

export { DEFAULT_DRIFT, DriftJob, type DriftOptions, driftOptionsFromEnv } from './drift.ts'
export { EVAL_COMPARE_ID } from './compare.ts'
export { EVAL_RUN_ID } from './run.ts'

/** Which slot an eval workflow reads: set by `createEvalWorkflows`, found again by `wireEval`. */
const slots = new WeakMap<AnyWorkflow, EvalSlot>()

/** `agw eval run` and `agw eval compare` (concept §6). They need the runtime, which exists after them: `wireEval`. */
export function createEvalWorkflows(options: EvalRunOptions = {}): HostWorkflow[] {
  const slot = new EvalSlot()
  const entries = [createEvalRun(slot, options), createEvalCompare(slot)]
  for (const entry of entries) slots.set(entry.workflow, slot)
  return entries
}

export interface EvalWiring {
  /** Starts the drift job; call after `runtime.open()`. */
  start(): void
  /** Stops the drift job and waits for its tick; call before `runtime.close()`. */
  close(): Promise<void>
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
  for (const entry of options.workflows) {
    const slot = slots.get(entry.workflow)
    if (!slot) continue
    slot.runtime = options.runtime
    for (const other of options.workflows)
      if (other.workflow.scorer) slot.targets.set(other.workflow.id, other.workflow)
  }
  const drift = new DriftJob(options.runtime, driftOptionsFromEnv(options.env ?? process.env), logger)
  return { start: () => drift.start(), close: () => drift.stop() }
}
