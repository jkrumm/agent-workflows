// A capability called over the host's HTTP door runs as a one-step run (concept N6): journal, record, purpose,
// fingerprint, telemetry, the Argo outbox and the limits apply to it like to any workflow. In-process calls
// (`registry.call` from a workflow step) stay plain calls; their usage belongs to the calling step.
import { createHash } from 'node:crypto'
import { type Capability, CapabilityCallError, ERRORS } from '@agent-workflows/capabilities'
import {
  type AnyWorkflow,
  defineWorkflow,
  IdempotencyConflict,
  type Json,
  type Logger,
  type Runtime,
  WorkflowError,
} from '@agent-workflows/runtime'
import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import { badRequest, type HostContext, idempotencyKeyOf, purposeOf, waitFor } from './operations.ts'
import type { RunState, RunStore } from './store.ts'

/** The response header that names the run behind a direct capability call. */
export const RUN_ID_HEADER = 'agw-run-id'

/** One build per capability list: the runtime and the host must hold the very same workflow objects. */
const builds = new WeakMap<readonly Capability[], Map<string, AnyWorkflow>>()

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

/**
 * The journal keeps a failure's kind and message only, so the message carries the typed error: `CODE: message
 * {"status":…,"data":…}`. The answer is rebuilt from it, the same in this process, in another one and on a replay.
 */
const journaled = (error: CapabilityCallError) =>
  `${error.code}: ${error.message} ${JSON.stringify({ status: error.status, data: error.data })}`

const JOURNALED = /^step "call" failed \(\w+\): ([A-Z_]+): (.*) (\{.*\})$/s

function build(capabilities: readonly Capability[]): Map<string, AnyWorkflow> {
  const known = builds.get(capabilities)
  if (known) return known
  const workflows = new Map<string, AnyWorkflow>()
  for (const capability of capabilities) {
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
  builds.set(capabilities, workflows)
  return workflows
}

/** The `cap.<id>` workflows of a registry, for the runtime's `workflows` (a resumed run must find its workflow). */
export function capabilityWorkflows(registry: { capabilities: readonly Capability[] }): AnyWorkflow[] {
  return [...build(registry.capabilities).values()]
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

/** The error the capability raised, as its own procedure answers it; oRPC re-checks `defined` against the data. */
function failureOf(state: RunState): ORPCError<string, unknown> {
  if (state.status === 'cancelled') return cancelled()
  const [, code, message, extra] = JOURNALED.exec(state.error?.message ?? '') ?? []
  if (code && message !== undefined && extra) {
    try {
      const { status, data } = JSON.parse(extra) as { status: number; data?: unknown }
      return new ORPCError(code, { defined: code in ERRORS, status, message, data })
    } catch {
      // not ours: answered as the opaque failure below
    }
  }
  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message: `run ${state.runId} failed (${state.error?.kind ?? 'error'}): ${state.error?.message ?? ''}`,
  })
}

/**
 * The host's `invoke`: starts the call's run with the request's purpose, `Idempotency-Key` and `traceparent`, waits
 * for it without a deadline, and answers with its output or the capability's error. A caller that goes away cancels
 * the run. The run id goes back in {@link RUN_ID_HEADER}.
 */
export function capabilityRuns(registry: { capabilities: readonly Capability[] }, deps: CapabilityRunDeps) {
  const workflows = build(registry.capabilities)
  return async ({ capability, input, signal, context }: CapabilityCall): Promise<unknown> => {
    const workflow = workflows.get(capability)
    if (!workflow) throw new Error(`capability ${capability} has no run workflow`)
    const { headers } = context
    const purpose = purposeOf(headers)
    const idempotencyKey = idempotencyKeyOf(headers)
    const traceparent = headers.get('traceparent') ?? undefined
    let runId: string
    try {
      ;({ runId } = await deps.runtime.start(workflow, input, { purpose, idempotencyKey, traceparent }))
    } catch (error) {
      if (error instanceof WorkflowError && error.kind === 'invalid_input') throw badRequest(error.message)
      if (error instanceof IdempotencyConflict) {
        throw new ORPCError('CONFLICT', { status: 409, message: error.message, data: { runId: error.runId } })
      }
      throw error
    }
    context.response.headers = { ...context.response.headers, [RUN_ID_HEADER]: runId }

    const state = await waitFor(deps.store, runId, Number.POSITIVE_INFINITY, deps.logger, signal)
    if (signal.aborted) {
      if (deps.isOpen()) {
        await deps.runtime.cancel(runId).catch((error: unknown) => {
          deps.logger.error('cancelling an abandoned capability run failed', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      throw cancelled()
    }
    if (!state) throw new Error(`run ${runId} vanished`)
    if (state.status === 'done') return state.output
    throw failureOf(state)
  }
}
