import { createHash } from 'node:crypto'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/

export function parseTraceparent(traceparent: string | null): { traceId: string; spanId: string } | null {
  const match = traceparent ? TRACEPARENT.exec(traceparent) : null
  return match?.[1] && match[2] ? { traceId: match[1], spanId: match[2] } : null
}

/**
 * A run's trace: the caller's (`traceparent`, which children inherit from their root), else one derived from the
 * root run id. Derived, not stored, so a resumed run in another process lands in the same trace.
 */
export function traceIdForRun(run: { rootId: string; traceparent: string | null }): string {
  return parseTraceparent(run.traceparent)?.traceId ?? sha256(`agw-trace:${run.rootId}`).slice(0, 32)
}

/** The span id of a run's admission span, derived so a resume or a child can link or parent to it. */
export function admissionSpanId(runId: string): string {
  return sha256(`agw-run-span:${runId}`).slice(0, 16)
}
