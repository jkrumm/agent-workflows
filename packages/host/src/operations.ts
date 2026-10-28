// Workflow and run operations, defined with oRPC + zod like the capabilities: one definition serves `call`,
// HTTP and the OpenAPI document. Every operation carries the same `x-cli` block as a capability.
import { type CliSpec, type RequestContext, type ResolvedCliSpec, withCli } from '@agent-workflows/capabilities'
import type { AnyWorkflow, Runtime } from '@agent-workflows/runtime'
import { WorkflowError } from '@agent-workflows/runtime'
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
  /** A handler sets this to override the success status (200 terminal, 202 not). */
  response: { status?: number }
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
}

export const RESUME = { command: ['run', 'wait'], positional: ['runId'] } as const

export interface OperationDeps {
  runtime: Runtime
  store: RunStore
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

const badRequest = (message: string) => new ORPCError('BAD_REQUEST', { message })

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

function purposeOf(headers: Headers): string {
  const purpose = headers.get('x-agw-purpose')?.trim()
  if (purpose === undefined || purpose === '') return DEFAULT_PURPOSE
  if (purpose.length > 64 || !/^[\w.-]+$/.test(purpose))
    throw badRequest('x-agw-purpose must be 1-64 of [A-Za-z0-9_.-]')
  return purpose
}

function idempotencyKeyOf(headers: Headers): string | undefined {
  const key = headers.get('idempotency-key')?.trim()
  if (!key) return undefined
  if (key.length > 255) throw badRequest('Idempotency-Key is longer than 255 characters')
  return key
}

const POLL_MIN_MS = 25
const POLL_MAX_MS = 250

/** Reads the run until it ends, `seconds` pass or the caller goes away; `null` when the run does not exist. */
async function waitFor(
  store: RunStore,
  runId: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<RunState | null> {
  const deadline = Date.now() + seconds * 1000
  let delay = POLL_MIN_MS
  for (;;) {
    const state = await store.get(runId)
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

const camel = (id: string) => id.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase())

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

function buildWorkflow(entry: HostWorkflow, deps: OperationDeps, cli: ResolvedCliSpec, path: string) {
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
      operationId: camel(workflow.id),
      summary: entry.summary ?? `Run ${workflow.id}`,
      tags: ['workflows'],
      spec: (operation) => withCli(cli)(withAccepted(operation, headers)),
    })
    .input(workflow.input as z.ZodObject)
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
        throw error
      }
      // The run exists from here on: a failed read must still report its id, or a retry starts a second run.
      const state = await waitFor(deps.store, runId, wait, signal).catch(() => null)
      return respond(context, state ?? { runId, workflowId: workflow.id, status: 'pending' })
    })
}

function buildRunOps(deps: OperationDeps) {
  const notFound = (runId: string) => new ORPCError('NOT_FOUND', { message: `Run ${runId} not found` })
  const cli = (command: string, mutating: boolean): ResolvedCliSpec => ({
    command: ['run', command],
    positional: ['runId'],
    mutating,
    defaultFormat: 'json',
    kind: 'run',
  })
  return {
    status: {
      method: 'GET' as const,
      path: '/runs/{runId}',
      cli: cli('status', false),
      procedure: base
        .route({
          method: 'GET',
          path: '/runs/{runId}',
          operationId: 'runStatus',
          summary: 'Show a run',
          tags: ['runs'],
          spec: (operation) => withCli(cli('status', false))(withAccepted(operation, [])),
        })
        .input(RunIdInput)
        .output(RunStateSchema)
        .handler(async ({ input, context }) => {
          const state = await deps.store.get(input.runId)
          if (!state) throw notFound(input.runId)
          return respond(context, state)
        }),
    },
    wait: {
      method: 'POST' as const,
      path: '/runs/{runId}/wait',
      cli: cli('wait', false),
      procedure: base
        .route({
          method: 'POST',
          path: '/runs/{runId}/wait',
          operationId: 'runWait',
          summary: 'Wait for a run to end (Prefer: wait=<seconds>)',
          tags: ['runs'],
          spec: (operation) => withCli(cli('wait', false))(withAccepted(operation, waitHeaders)),
        })
        .input(RunIdInput)
        .output(RunStateSchema)
        .handler(async ({ input, context, signal }) => {
          const state = await waitFor(deps.store, input.runId, preferWait(context.headers), signal)
          if (!state) throw notFound(input.runId)
          return respond(context, state)
        }),
    },
    cancel: {
      method: 'POST' as const,
      path: '/runs/{runId}/cancel',
      cli: cli('cancel', true),
      procedure: base
        .route({
          method: 'POST',
          path: '/runs/{runId}/cancel',
          operationId: 'runCancel',
          summary: 'Cancel a run; an ended run answers with its state',
          tags: ['runs'],
          spec: (operation) => withCli(cli('cancel', true))(withAccepted(operation, waitHeaders)),
        })
        .input(RunIdInput)
        .output(RunStateSchema)
        .handler(async ({ input, context, signal }) => {
          const wait = preferWait(context.headers, CANCEL_GRACE_S) // before the cancel: a 400 must change nothing
          if (!(await deps.store.get(input.runId))) throw notFound(input.runId)
          await deps.runtime.cancel(input.runId)
          const state = await waitFor(deps.store, input.runId, wait, signal)
          if (!state) throw notFound(input.runId)
          return respond(context, state)
        }),
    },
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
    operationId: camel(workflow.id),
    method: 'POST',
    path,
    cli,
    procedure: buildWorkflow(entry, deps, cli, path),
  }
}

export function runOperations(deps: OperationDeps): Record<'status' | 'wait' | 'cancel', HostOperation> {
  const ops = buildRunOps(deps)
  return {
    status: { operationId: 'runStatus', ...ops.status },
    wait: { operationId: 'runWait', ...ops.wait },
    cancel: { operationId: 'runCancel', ...ops.cancel },
  }
}
