import type { Runtime } from '@agent-workflows/runtime'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** The run state body of the host contract: workflow start, run status, run wait, run cancel. */
export type RunState = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
  /** Ended runs with a written record: the final cost (null: nothing priced) and the unpriced calls. */
  cost?: number | null
  unpricedCalls?: number
  /** An ended run whose record is not written: still to come, or never (hooks gave up). `cost` is absent. */
  costPending?: true
}

/**
 * What a store reads: the wire state plus what the wait decides the record question with. Every store says all three
 * (none is optional), so a store cannot make the wait fall back to its slow path by omission.
 */
export type StoredRun = RunState & {
  /** The run record (cost, unpriced calls) is written. */
  recorded: boolean
  /** `runPost` ran or was given up on. */
  postHooksDone: boolean
  /** When the run ended, in ms since the epoch; null while it runs. */
  endedAt: number | null
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
        ...(isTerminal(run.status) ? { cost: run.cost, unpricedCalls: run.unpricedCalls } : {}),
        recorded: run.recorded,
        postHooksDone: run.postHooksDone,
        endedAt: run.finishedAt?.getTime() ?? null,
      }
    },
    ping: (timeoutMs) => runtime.ping(timeoutMs),
  }
}
