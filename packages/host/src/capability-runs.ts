// A capability called over the host's HTTP door runs as a one-step run (concept N6): journal, record, purpose,
// fingerprint, telemetry, the Argo outbox and the limits apply to it like to any workflow. In-process calls
// (`registry.call` from a workflow step) stay plain calls; their usage belongs to the calling step.
import { createHash } from 'node:crypto'
import { type Capability, CapabilityCallError, ERRORS } from '@agent-workflows/capabilities'
import { type AnyWorkflow, defineWorkflow, type Json, type Logger, type Runtime } from '@agent-workflows/runtime'
import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import { type HostContext, startRun, waitFor } from './operations.ts'
import { isTerminal, type RunState, type RunStore } from './store.ts'

/** The response header that names the run behind a direct capability call. */
export const RUN_ID_HEADER = 'agw-run-id'

/**
 * The `cap.<id>` workflow of every capability, by capability id. Built once in `boot` and handed to both the runtime
 * (a resumed run must find its workflow) and the host: they must hold the very same objects.
 */
export type CapabilityWorkflows = ReadonlyMap<string, AnyWorkflow>

const workflowIdOf = (capability: string) => `cap.${capability}`

/** Capabilities carry no version: a hash of what defines one (schemas, summary, handler source) stands in. */
function versionOf(capability: Capability): string {
  const definition = {
    id: capability.id,
    summary: capability.summary,
    input: z.toJSONSchema(capability.input, { unrepresentable: 'any' }),
    output: z.toJSONSchema(capability.output, { unrepresentable: 'any' }),
    handler: capability.handler.toString(),
  }
  return createHash('sha256').update(canonicalJson(definition)).digest('hex').slice(0, 12)
}

const MARKER = 'agwCapabilityError'

/**
 * The journal keeps a failure's kind and message only, so the message carries the typed error: `CODE: message`, a
 * newline, then one JSON line `{"agwCapabilityError":1,"code","status","data"}` (JSON.stringify never emits a raw
 * newline). The answer is rebuilt from that last line, the same in this process, in another one and on a replay.
 */
export const journaled = (error: CapabilityCallError) =>
  `${error.code}: ${error.message}\n${JSON.stringify({ [MARKER]: 1, code: error.code, status: error.status, data: error.data })}`

/** How the runtime words a failed step; the run's message when its one step failed. */
const STEP_FAILED = /^step "call" failed \((\w+)\): /

type Journaled = { code: string; status: number; data?: unknown }

const isJournaled = (value: unknown): value is Journaled =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>)[MARKER] === 1 &&
  typeof (value as Journaled).code === 'string' &&
  typeof (value as Journaled).status === 'number'

/** The capability's typed error a failed run journaled; null when the failure was not one. */
export function journaledError(text: string): ORPCError<string, unknown> | null {
  const prefix = STEP_FAILED.exec(text)
  const newline = text.lastIndexOf('\n')
  if (!prefix || newline < prefix[0].length) return null
  let record: unknown
  try {
    record = JSON.parse(text.slice(newline + 1))
  } catch {
    return null
  }
  if (!isJournaled(record)) return null
  const head = text.slice(prefix[0].length, newline)
  const message = head.startsWith(`${record.code}: `) ? head.slice(record.code.length + 2) : head
  return new ORPCError(record.code, {
    defined: record.code in ERRORS,
    status: record.status,
    message,
    data: record.data,
  })
}

export function createCapabilityWorkflows(registry: { capabilities: readonly Capability[] }): CapabilityWorkflows {
  const workflows = new Map<string, AnyWorkflow>()
  for (const capability of registry.capabilities) {
    const workflow = defineWorkflow({
      id: workflowIdOf(capability.id),
      version: versionOf(capability),
      input: capability.input,
      output: capability.output,
      async run(ctx, input) {
        return ctx.step('call', async ({ addUsage, signal }) => {
          try {
            return (await capability.call(input, { addUsage, signal })) as Json
          } catch (error) {
            if (!(error instanceof CapabilityCallError)) throw error
            throw new Error(journaled(error), { cause: error })
          }
        })
      },
    })
    workflows.set(capability.id, workflow)
  }
  return workflows
}

export interface CapabilityRunDeps {
  runtime: Runtime
  store: RunStore
  logger: Logger
  /** False while the host shuts down: a request cut by the shutdown leaves its run to recovery. */
  isOpen: () => boolean
}

export interface CapabilityCall {
  capability: string
  /** Already validated against the capability's input. */
  input: unknown
  signal: AbortSignal
  context: Pick<HostContext, 'headers' | 'response'>
}

const cancelled = () =>
  new ORPCError('CANCELLED', { defined: true, status: ERRORS.CANCELLED.status, message: ERRORS.CANCELLED.message })

/** Admission and runaway refusals: the same kinds a workflow route reports in its failed run state. */
const REFUSALS = new Set(['admission_refused', 'middleware'])

/**
 * The answer of a failed or cancelled run: the capability's own typed error when it raised one; a refusal as a 503
 * with its reason (what a workflow caller reads in the run state); anything else an opaque 500, its detail logged.
 */
export function failureOf(state: RunState, logger: Logger): ORPCError<string, unknown> {
  if (state.status === 'cancelled') return cancelled()
  const text = state.error?.message ?? ''
  const typed = journaledError(text)
  if (typed) return typed
  const step = STEP_FAILED.exec(text)
  const kind = state.error?.kind === 'step_failed' && step ? step[1] : state.error?.kind
  if (kind && REFUSALS.has(kind)) {
    return new ORPCError('SERVICE_UNAVAILABLE', {
      status: 503,
      message: step ? text.slice(step[0].length) : text,
      data: { runId: state.runId, kind },
    })
  }
  logger.error('capability run failed', { runId: state.runId, kind: state.error?.kind, error: text })
  return new ORPCError('INTERNAL_SERVER_ERROR', { message: `run ${state.runId} failed` })
}

/**
 * The host's `invoke`: starts the call's run with the request's purpose, `Idempotency-Key` and `traceparent`, waits
 * for it without a deadline, and answers with its output or the capability's error. A caller that goes away cancels
 * the run. The run id goes back in {@link RUN_ID_HEADER}.
 */
export function capabilityRuns(workflows: CapabilityWorkflows, deps: CapabilityRunDeps) {
  return async ({ capability, input, signal, context }: CapabilityCall): Promise<unknown> => {
    const workflow = workflows.get(capability)
    if (!workflow) throw new Error(`capability ${capability} has no run workflow`)
    const { runId, idempotencyKey } = await startRun(deps, workflow, input, context.headers)
    context.response.headers = { ...context.response.headers, [RUN_ID_HEADER]: runId }

    // No deadline: the wait ends when the run does, or early only when the caller goes away.
    // It reads the output only, so it does not pay the hold for the run record.
    const state = await waitFor(deps.store, runId, Number.POSITIVE_INFINITY, deps.logger, signal, 0)
    if (!state) throw new Error(`run ${runId} vanished`)
    if (state.status === 'done') return state.output
    if (isTerminal(state.status)) throw failureOf(state, deps.logger)
    // The caller went away mid-run. A keyed run is left to finish, so a retry with the key gets its result; an unkeyed
    // one was created by this request alone (`start` without a key always inserts) and is cancelled, unless the host
    // is shutting down and recovery owns it.
    if (!idempotencyKey && deps.isOpen()) {
      await deps.runtime.cancel(runId).catch((error: unknown) => {
        deps.logger.error('cancelling an abandoned capability run failed', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    throw cancelled()
  }
}
