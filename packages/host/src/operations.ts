// Workflow and run operations, defined with oRPC + zod like the capabilities: one definition serves `call`,
// HTTP and the OpenAPI document. Every operation carries the same `x-cli` block as a capability.
import {
  type CliSpec,
  operationIdOf,
  type RequestContext,
  type ResolvedCliSpec,
  withCli,
} from '@agent-workflows/capabilities'
import type { AgentRef } from '@agent-workflows/middleware'
import type { AnyWorkflow, Logger, Runtime } from '@agent-workflows/runtime'
import { IdempotencyConflict, WorkflowError } from '@agent-workflows/runtime'
import { ORPCError, os } from '@orpc/server'
import { z } from 'zod'
import { isTerminal, type RunState, type RunStore } from './store.ts'

/** The most one request waits: Bun's `idleTimeout` ceiling is 255 s, so a held request must answer before it. */
export const MAX_WAIT_S = 240
export const IDLE_TIMEOUT_S = 255
/** How long `run cancel` waits for a running run to reach `cancelled` when the caller gave no `Prefer: wait`. */
const CANCEL_GRACE_S = 10

export const DEFAULT_PURPOSE = 'prod'

/** What the host's fetch hands every procedure. */
export type HostContext = RequestContext & {
  headers: Headers
  /** A handler sets these to override the success status (200 terminal, 202 not) and to add response headers. */
  response: { status?: number; headers?: Record<string, string> }
}

const base = os.$context<HostContext>().errors({
  NOT_FOUND: { status: 404, message: 'Not found' },
  CONFLICT: { status: 409, message: 'Conflict' },
})

const RunStateSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']),
  output: z.unknown().optional().describe("The workflow's output, once done"),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
})

const RunIdInput = z.object({ runId: z.string().min(1).describe('The run id') })

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/

/** What a workflow needs beyond its definition to appear as a command; the runtime's definition has no CLI notion. */
export interface HostWorkflow {
  workflow: AnyWorkflow
  summary?: string
  cli?: Pick<CliSpec, 'positional' | 'stdin' | 'mutating' | 'defaultFormat' | 'plainField'>
  /** The agents the workflow's steps run, with their routes: they feed the run fingerprint (concept §5). */
  agents?: AgentRef[]
  /** Optional expensive work: the wallet gate refuses it at admission (concept §4). */
  optionalExpensive?: boolean
}

/** The CLI's own flags always win (`--format`, `--commit`, `--idempotency-key`, `--help`): no input may take them. */
export const RESERVED_FLAGS = ['format', 'commit', 'idempotencyKey', 'idempotency-key', 'help'] as const

export function assertNoReservedFlags(owner: string, input: z.ZodObject) {
  for (const name of Object.keys(input.shape)) {
    if ((RESERVED_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`${owner}: input property "${name}" is a reserved CLI flag (${RESERVED_FLAGS.join(', ')})`)
    }
  }
}

export const RESUME = { command: ['run', 'wait'], positional: ['runId'] } as const

export interface OperationDeps {
  runtime: Runtime
  store: RunStore
  logger: Logger
}

export type HostOperation = {
  /** Unique across the process: the oRPC operation id. */
  operationId: string
  method: 'GET' | 'POST'
  path: string
  cli: ResolvedCliSpec
  /** An oRPC procedure; the host puts it into its router. */
  procedure: object
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const badRequest = (message: string) => new ORPCError('BAD_REQUEST', { message })

/** `Prefer: wait=<seconds>`, capped at {@link MAX_WAIT_S}; `fallback` (default 0) when the header names no wait. */
export function preferWait(headers: Headers, fallback = 0): number {
  const prefer = headers.get('prefer')
  if (!prefer) return fallback
  const match = /(?:^|[\s,;])wait=("?)(\d+(?:\.\d+)?)\1(?=$|[\s,;])/i.exec(prefer)
  if (!match) {
    if (/(?:^|[\s,;])wait\b/i.test(prefer)) throw badRequest('Prefer: wait must be a number of seconds')
    return fallback
  }
  return Math.min(Number(match[2]), MAX_WAIT_S)
}

export function purposeOf(headers: Headers): string {
  const purpose = headers.get('x-agw-purpose')?.trim()
  if (purpose === undefined || purpose === '') return DEFAULT_PURPOSE
  if (purpose.length > 64 || !/^[\w.-]+$/.test(purpose))
    throw badRequest('x-agw-purpose must be 1-64 of [A-Za-z0-9_.-]')
  return purpose
}

export function idempotencyKeyOf(headers: Headers): string | undefined {
  const key = headers.get('idempotency-key')?.trim()
  if (!key) return undefined
  if (key.length > 255) throw badRequest('Idempotency-Key is longer than 255 characters')
  return key
}

const POLL_MIN_MS = 25
const POLL_MAX_MS = 250

/** A read that keeps failing this many times in a row ends the wait: a dead database must not hold a request. */
const MAX_READ_FAILURES = 5

/**
 * Reads the run until it ends, `seconds` pass (`Infinity`: no deadline) or the caller goes away; `null` when the run
 * does not exist. A failed read is logged and retried on the same backoff, inside the deadline; the error surfaces
 * once reads fail {@link MAX_READ_FAILURES} times in a row or the deadline passes with the last read failing.
 */
export async function waitFor(
  store: RunStore,
  runId: string,
  seconds: number,
  logger: Logger,
  signal?: AbortSignal,
): Promise<RunState | null> {
  const deadline = Date.now() + seconds * 1000
  let delay = POLL_MIN_MS
  let failures = 0
  for (;;) {
    let state: RunState | null
    try {
      state = await store.get(runId)
      failures = 0
    } catch (error) {
      failures++
      logger.warn('run state read failed', { runId, attempt: failures, error: errorText(error) })
      const left = deadline - Date.now()
      if (failures >= MAX_READ_FAILURES || left <= 0 || signal?.aborted) throw error
      await Bun.sleep(Math.min(delay, left))
      delay = Math.min(delay * 2, POLL_MAX_MS)
      continue
    }
    if (!state || isTerminal(state.status) || signal?.aborted) return state
    const left = deadline - Date.now()
    if (left <= 0) return state
    await Bun.sleep(Math.min(delay, left))
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

function respond(context: HostContext, state: RunState): RunState {
  context.response.status = isTerminal(state.status) ? 200 : 202
  return state
}

const waitHeaders = [
  {
    name: 'Prefer',
    in: 'header',
    required: false,
    schema: { type: 'string' },
    description: 'wait=<seconds>, at most 240',
  },
] as const

/** 202 answers with the same body as 200: the run is not finished yet. */
const withAccepted = <T extends { parameters?: readonly object[]; responses?: Record<string, unknown> }>(
  operation: T,
  extra: readonly object[],
): T => ({
  ...operation,
  parameters: [...(operation.parameters ?? []), ...extra],
  responses: {
    ...operation.responses,
    ...(operation.responses?.['200']
      ? { '202': { ...operation.responses['200'], description: 'Accepted: the run has not ended' } }
      : {}),
  },
})

function buildWorkflow(
  entry: HostWorkflow,
  input: z.ZodObject,
  deps: OperationDeps,
  cli: ResolvedCliSpec,
  path: string,
) {
  const { workflow } = entry
  const headers = [
    ...waitHeaders,
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string' },
      description: 'A repeat returns the same run',
    },
    {
      name: 'x-agw-purpose',
      in: 'header',
      required: false,
      schema: { type: 'string' },
      description: `Why this run exists; default ${DEFAULT_PURPOSE}`,
    },
  ]
  return base
    .route({
      method: 'POST',
      path: path as `/${string}`,
      operationId: operationIdOf(workflow.id),
      summary: entry.summary ?? `Run ${workflow.id}`,
      tags: ['workflows'],
      spec: (operation) => withCli(cli)(withAccepted(operation, headers)),
    })
    .input(input.strict()) // an unknown key is a 400, never silently dropped
    .output(RunStateSchema)
    .handler(async ({ input, context, signal }) => {
      const wait = preferWait(context.headers)
      const purpose = purposeOf(context.headers)
      const idempotencyKey = idempotencyKeyOf(context.headers)
      const traceparent = context.headers.get('traceparent') ?? undefined
      let runId: string
      try {
        ;({ runId } = await deps.runtime.start(workflow, input, { purpose, idempotencyKey, traceparent }))
      } catch (error) {
        if (error instanceof WorkflowError && error.kind === 'invalid_input') throw badRequest(error.message)
        if (error instanceof IdempotencyConflict) {
          throw new ORPCError('CONFLICT', { message: error.message, data: { runId: error.runId } })
        }
        throw error
      }
      // The run exists from here on: a failed read must still report its id, or a retry starts a second run.
      const state = await waitFor(deps.store, runId, wait, deps.logger, signal).catch((error: unknown) => {
        deps.logger.error('run state read failed after start; answering 202', { runId, error: errorText(error) })
        return null
      })
      return respond(context, state ?? { runId, workflowId: workflow.id, status: 'pending' })
    })
}

type RunOpArgs = { input: { runId: string }; context: HostContext; signal?: AbortSignal }

/** One run operation; its name is stated once (`run.<name>`) and gives the command and the operation id. */
function runOp(spec: {
  name: 'status' | 'wait' | 'cancel'
  method: 'GET' | 'POST'
  path: `/runs/${string}`
  summary: string
  mutating: boolean
  headers: readonly object[]
  handler: (args: RunOpArgs) => Promise<RunState>
}): HostOperation {
  const id = `run.${spec.name}`
  const operationId = operationIdOf(id)
  const cli: ResolvedCliSpec = {
    command: id.split('.'),
    positional: ['runId'],
    mutating: spec.mutating,
    defaultFormat: 'json',
    kind: 'run',
  }
  const procedure = base
    .route({
      method: spec.method,
      path: spec.path,
      operationId,
      summary: spec.summary,
      tags: ['runs'],
      spec: (operation) => withCli(cli)(withAccepted(operation, spec.headers)),
    })
    .input(RunIdInput)
    .output(RunStateSchema)
    .handler(({ input, context, signal }) => spec.handler({ input, context, signal }))
  return { operationId, method: spec.method, path: spec.path, cli, procedure }
}

export function runOperations(deps: OperationDeps): Record<'status' | 'wait' | 'cancel', HostOperation> {
  const notFound = (runId: string) => new ORPCError('NOT_FOUND', { message: `Run ${runId} not found` })
  return {
    status: runOp({
      name: 'status',
      method: 'GET',
      path: '/runs/{runId}',
      summary: 'Show a run',
      mutating: false,
      headers: [],
      async handler({ input, context }) {
        const state = await deps.store.get(input.runId)
        if (!state) throw notFound(input.runId)
        return respond(context, state)
      },
    }),
    wait: runOp({
      name: 'wait',
      method: 'POST',
      path: '/runs/{runId}/wait',
      summary: 'Wait for a run to end (Prefer: wait=<seconds>)',
      mutating: false,
      headers: waitHeaders,
      async handler({ input, context, signal }) {
        const state = await waitFor(deps.store, input.runId, preferWait(context.headers), deps.logger, signal)
        if (!state) throw notFound(input.runId)
        return respond(context, state)
      },
    }),
    cancel: runOp({
      name: 'cancel',
      method: 'POST',
      path: '/runs/{runId}/cancel',
      summary: 'Cancel a run; an ended run answers with its state',
      mutating: true,
      headers: waitHeaders,
      async handler({ input, context, signal }) {
        const wait = preferWait(context.headers, CANCEL_GRACE_S) // before the cancel: a 400 must change nothing
        if (!(await deps.store.get(input.runId))) throw notFound(input.runId)
        await deps.runtime.cancel(input.runId)
        const state = await waitFor(deps.store, input.runId, wait, deps.logger, signal)
        if (!state) throw notFound(input.runId)
        return respond(context, state)
      },
    }),
  }
}

/** The command a workflow appears under: its id split on dots. */
export function workflowOperation(entry: HostWorkflow, deps: OperationDeps): HostOperation {
  const { workflow } = entry
  if (!ID_PATTERN.test(workflow.id)) {
    throw new Error(`workflow id "${workflow.id}" must be dotted lowercase, e.g. "smoke.ping"`)
  }
  const input = workflow.input
  if (!(input instanceof z.ZodObject)) throw new Error(`workflow ${workflow.id}: input must be a z.object`)
  assertNoReservedFlags(`workflow ${workflow.id}`, input)
  const properties = Object.keys(input.shape)
  for (const name of [...(entry.cli?.positional ?? []), ...(entry.cli?.stdin ? [entry.cli.stdin] : [])]) {
    if (!properties.includes(name))
      throw new Error(`workflow ${workflow.id}: cli names "${name}", not a property of its input`)
  }
  const cli: ResolvedCliSpec = {
    command: workflow.id.split('.'),
    positional: entry.cli?.positional ?? [],
    mutating: entry.cli?.mutating ?? false,
    defaultFormat: entry.cli?.defaultFormat ?? 'json',
    kind: 'workflow',
    resume: { command: [...RESUME.command], positional: [...RESUME.positional] },
    ...(entry.cli?.stdin ? { stdin: entry.cli.stdin } : {}),
    ...(entry.cli?.plainField ? { plainField: entry.cli.plainField } : {}),
  }
  const path = `/workflows/${workflow.id.split('.').join('/')}`
  return {
    operationId: operationIdOf(workflow.id),
    method: 'POST',
    path,
    cli,
    procedure: buildWorkflow(entry, input, deps, cli, path),
  }
}
