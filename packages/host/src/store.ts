import type { Runtime } from '@agent-workflows/runtime'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** The run state body of the host contract: workflow start, run status, run wait, run cancel. */
export type RunState = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
  /** Terminal runs only: the run record's final cost (null: nothing priced) and unpriced calls. */
  cost?: number | null
  unpricedCalls?: number
  /** True when the run ended but its record (`runPost`) had not landed, so `cost` is not final. */
  costPending?: true
  /** Not on the wire: whether `runPost` has run, which `waitFor` holds a terminal answer for. */
  postHooksDone?: boolean
}

export const isTerminal = (status: RunStatus) => status === 'done' || status === 'failed' || status === 'cancelled'

/** What the HTTP bodies and `/health` read; production is a thin adapter over the runtime's public read API. */
export interface RunStore {
  get(runId: string): Promise<RunState | null>
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
        ...(isTerminal(run.status)
          ? { cost: run.cost, unpricedCalls: run.unpricedCalls, postHooksDone: run.postHooksDone }
          : {}),
      }
    },
    ping: (timeoutMs) => runtime.ping(timeoutMs),
  }
}
