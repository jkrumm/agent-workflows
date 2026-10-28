import type { Runtime } from '@agent-workflows/runtime'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** The run state body of the host contract: workflow start, run status, run wait, run cancel. */
export type RunState = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
}

export const isTerminal = (status: RunStatus) => status === 'done' || status === 'failed' || status === 'cancelled'

/** What the HTTP bodies and `/health` read; production is a thin adapter over the runtime's public read API. */
export interface RunStore {
  get(runId: string): Promise<RunState | null>
  /** Resolves when the journal database answers. */
  ping(): Promise<void>
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
        ...(run.output !== null ? { output: run.output } : {}),
        ...(run.error ? { error: run.error } : {}),
      }
    },
    ping: () => runtime.ping(),
  }
}
