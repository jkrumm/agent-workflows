import type { Runtime } from '@agent-workflows/runtime'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * The run state body of the host contract: workflow start, run status, run wait, run cancel. An ended run carries one
 * of three things about its run record (the cost sums over its own steps; a fan-out child has its own record):
 * `cost` and `unpricedCalls` once the post hooks delivered, `costPending` while they have not, `recordFailed` when
 * the runtime gave up on them.
 */
export type RunState = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
  cost?: number | null
  unpricedCalls?: number
  costPending?: true
  recordFailed?: true
}

/** What a store reads of a run; `waitFor` and `toRunState` decide what of it reaches the wire. */
export type StoredRun = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
  /** The run record's sums over the run's own steps; meaningful once `postHooksDone && !postHooksFailed`. */
  cost: number | null
  unpricedCalls: number
  /** The post hooks (the run record among them) were delivered or given up on. */
  postHooksDone: boolean
  /** They were given up on: the run record may be missing. */
  postHooksFailed: boolean
}

export const isTerminal = (status: RunStatus) => status === 'done' || status === 'failed' || status === 'cancelled'

/** What the HTTP bodies and `/health` read; production is a thin adapter over the runtime's public read API. */
export interface RunStore {
  get(runId: string): Promise<StoredRun | null>
  /** Resolves when the journal database answers; rejects after `timeoutMs`, ending the query itself. */
  ping(timeoutMs?: number): Promise<void>
}

export function runtimeRunStore(runtime: Pick<Runtime, 'getRun' | 'ping'>): RunStore {
  return {
    async get(runId) {
      const run = await runtime.getRun(runId)
      if (!run) return null
      return {
        runId: run.runId,
        workflowId: run.workflowId,
        status: run.status,
        // a done run's output is whatever the workflow returned, `null` included
        ...(run.status === 'done' ? { output: run.output } : {}),
        ...(run.error ? { error: run.error } : {}),
        cost: run.cost,
        unpricedCalls: run.unpricedCalls,
        postHooksDone: run.postHooksDone,
        postHooksFailed: run.postHooksFailed,
      }
    },
    ping: (timeoutMs) => runtime.ping(timeoutMs),
  }
}
