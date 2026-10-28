/** Why a run or step ended without output. Persisted in `error_kind`. */
export type ErrorKind =
  | 'error'
  | 'invalid_input'
  | 'invalid_output'
  | 'non_json_output'
  | 'step_failed'
  | 'timeout'
  | 'cancelled'
  | 'duplicate_step'
  | 'admission_refused'
  | 'middleware'
  | 'infra'
  | 'crash_loop'

/**
 * `start` with an idempotency key already used by this workflow for a different input. The first run stands; the
 * caller must pick a new key or resend the original input.
 */
export class IdempotencyConflict extends Error {
  override name = 'IdempotencyConflict'
  constructor(
    readonly workflowId: string,
    readonly idempotencyKey: string,
    readonly runId: string,
  ) {
    super(`idempotency key "${idempotencyKey}" was already used for a different input of ${workflowId} (run ${runId})`)
  }
}

/** A failure that belongs to the workflow: it ends the step or run as `failed` (or `cancelled`). */
export class WorkflowError extends Error {
  override name = 'WorkflowError'
  constructor(
    readonly kind: ErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** Thrown into `run` when a step failed; replays identically from the journal. */
export class StepFailed extends WorkflowError {
  override name = 'StepFailed'
  constructor(
    readonly stepId: string,
    readonly stepKind: ErrorKind,
    readonly reason: string,
  ) {
    super('step_failed', `step "${stepId}" failed (${stepKind}): ${reason}`)
  }
}

/** No `progress()` from the step body or the agent host for `idleMs`: wedged, never a wall-clock cap. */
export class StepTimeout extends WorkflowError {
  override name = 'StepTimeout'
  constructor(stepId: string, idleMs: number) {
    super('timeout', `step "${stepId}" idle for ${idleMs} ms`)
  }
}

export class Cancelled extends WorkflowError {
  override name = 'Cancelled'
  constructor(runId: string) {
    super('cancelled', `run ${runId} was cancelled`)
  }
}

/**
 * A `toolPre` hook threw: the step fails with the hook error's kind (a `WorkflowError`'s, else `middleware`) and is
 * not retried. The original error is the `cause`.
 */
export class ToolRefused extends WorkflowError {
  override name = 'ToolRefused'
  constructor(refused: unknown) {
    super(
      refused instanceof WorkflowError ? refused.kind : 'middleware',
      `toolPre refused: ${refused === undefined ? 'no reason' : errorMessage(refused)}`,
      { cause: refused },
    )
  }
}

/** Thrown by a `runPre` middleware to refuse a new run. Ignored (logged) when the run resumes. */
export class AdmissionRefused extends Error {
  override name = 'AdmissionRefused'
}

/**
 * The journal or the lease failed, not the workflow. The run is left `running` and retried with backoff;
 * nothing is marked `failed`.
 */
export class InfraError extends Error {
  override name = 'InfraError'
}

/** The lease connection dropped or another process took the run over: stop writing at once. */
export class LeaseLost extends InfraError {
  override name = 'LeaseLost'
}

/** The process is shutting down (`runtime.close()`): the run stays `running` for the next process. */
export class Shutdown extends InfraError {
  override name = 'Shutdown'
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function errorKind(err: unknown): ErrorKind {
  return err instanceof WorkflowError ? err.kind : 'error'
}
