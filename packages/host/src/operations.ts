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
import { isTerminal, type RunState, type RunStore, type StoredRun } from './store.ts'

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
  cost: z
    .number()
    .nullable()
    .optional()
    .describe(
      "An ended run whose post hooks delivered: the USD cost of the run's own steps (null: nothing priced). A child run of a fan-out carries its own record, so a parent's cost does not include it",
    ),
  unpricedCalls: z
    .number()
    .int()
    .optional()
    .describe('With cost: calls of the run own steps with no price; above 0 the cost is a lower bound'),
  costPending: z
    .literal(true)
    .optional()
    .describe('An ended run whose post hooks (the run record among them) are not delivered yet; ask again'),
  recordFailed: z
    .literal(true)
    .optional()
    .describe(
      'The runtime gave up delivering the ended run post hooks, so its record may be missing; no cost is given',
    ),
})

const RunIdInput = z.object({ runId: z.string().min(1).describe('The run id') })

// A hyphen inside a segment is allowed (`prose-gate`): only between alphanumerics and before a letter, so never leading,
// trailing, doubled or before a digit. The command is the id split on dots, a segment one word.
const SEGMENT = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*'
const ID_PATTERN = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`)

/** The operation id of a workflow, for the route and for the uniqueness check: `prose-gate` → `proseGate`. */
const workflowOperationId = (id: string) => operationIdOf(id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))

/** What a workflow needs beyond its definition to appear as a command; the runtime's definition has no CLI notion. */
export interface HostWorkflow {
  workflow: AnyWorkflow
  summary?: string
  cli?: Pick<CliSpec, 'positional' | 'stdin' | 'mutating' | 'defaultFormat' | 'plainField'>
  /** The agents the workflow's steps run, with their routes: they feed the run fingerprint (concept §5). */
  agents?: AgentRef[]
  /** Optional expensive work: the wallet gate refuses it at admission (concept §4). */
  optionalExpensive?: boolean
  /**
   * A child of another workflow only: registered with the runtime (the parent's `ctx.workflow` and resume find it), never
   * an HTTP route, a CLI command or an `agw schema` entry. Its id may then share a prefix with a public command.
   */
  internal?: true
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

/**
 * Starts a run from a request: purpose, `Idempotency-Key` and `traceparent` from its headers; an invalid input is a
 * 400, a key reused for another input a 409 naming the run that stands. The workflow route and direct capability
 * calls both start through here.
 */
export async function startRun(
  deps: Pick<OperationDeps, 'runtime'>,
  workflow: AnyWorkflow,
  input: unknown,
  headers: Headers,
): Promise<{ runId: string; idempotencyKey: string | undefined }> {
  const purpose = purposeOf(headers)
  const idempotencyKey = idempotencyKeyOf(headers)
  const traceparent = headers.get('traceparent') ?? undefined
  try {
    const { runId } = await deps.runtime.start(workflow, input, { purpose, idempotencyKey, traceparent })
    return { runId, idempotencyKey }
  } catch (error) {
    if (error instanceof WorkflowError && error.kind === 'invalid_input') throw badRequest(error.message)
    if (error instanceof IdempotencyConflict) {
      throw new ORPCError('CONFLICT', { status: 409, message: error.message, data: { runId: error.runId } })
    }
    throw error
  }
}

/**
 * How long a wait that saw its run end holds for the run record. `Runtime.finish` commits the terminal status first and
 * `runPost` writes the record after it, so an answer at the status alone could precede it. The record takes
 * milliseconds normally; five seconds is far above that and still bounded when a hook is slow or stuck, in which case
 * the answer says `costPending`.
 */
export const RECORD_WAIT_MS = 5000

const POLL_MIN_MS = 25
const POLL_MAX_MS = 250

/** A read that keeps failing this many times in a row ends the wait: a dead database must not hold a request. */
const MAX_READ_FAILURES = 5
/** Failed reads one wait logs; a hold or a long wait retries far more often than this. */
const MAX_READ_WARNINGS = 3

type Read = { ok: true; run: StoredRun | null } | { ok: false; error: unknown; failures: number }

/** One place for a read of the run: counts the failures in a row and logs the first few of them. */
function runReader(store: RunStore, runId: string, logger: Logger) {
  let failures = 0
  let warned = 0
  return async (): Promise<Read> => {
    try {
      const run = await store.get(runId)
      failures = 0
      return { ok: true, run }
    } catch (error) {
      failures++
      if (warned++ < MAX_READ_WARNINGS) {
        logger.warn('run state read failed', { runId, attempt: failures, error: errorText(error) })
      }
      return { ok: false, error, failures }
    }
  }
}

export interface WaitOptions {
  store: RunStore
  runId: string
  /** How long to wait for the run to end; `Infinity`: no deadline. */
  seconds: number
  logger: Logger
  signal?: AbortSignal
  /**
   * A run this very wait saw end is held up to this long (beyond `seconds`) for its record, so the answer carries the
   * cost. 0 (the default): answer the record as it is. A wait that finds the run already ended never holds.
   */
  recordWaitMs?: number
}

/**
 * Reads the run until it ends, `seconds` pass or the caller goes away; `null` when the run does not exist. A failed
 * read is logged (the first few) and retried on the same backoff, inside the deadline; the error surfaces once reads
 * fail {@link MAX_READ_FAILURES} times in a row or the deadline passes with the last read failing.
 *
 * With `recordWaitMs`, a run seen turning terminal is then held until its post hooks are delivered, restarting the
 * backoff, and read failures in the hold are retried until the hold's deadline, which answers with the state in hand
 * (`costPending`). No clock is compared: the hold is for the transition this call saw, nothing older.
 */
export async function waitFor(options: WaitOptions): Promise<RunState | null> {
  const { store, runId, seconds, signal, recordWaitMs = 0 } = options
  const read = runReader(store, runId, options.logger)
  const deadline = Date.now() + seconds * 1000
  let delay = POLL_MIN_MS
  let sawLive = false
  let hold: { until: number; last: StoredRun } | null = null
  const backoff = async (limit: number) => {
    await Bun.sleep(Math.max(0, Math.min(delay, limit - Date.now())))
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
  for (;;) {
    const result = await read()
    if (!result.ok) {
      const limit = hold ? hold.until : deadline
      const out = Date.now() >= limit || signal?.aborted
      if (hold) {
        if (out) return toRunState(hold.last)
      } else if (result.failures >= MAX_READ_FAILURES || out) {
        throw result.error
      }
      await backoff(limit)
      continue
    }
    const run = result.run
    if (!run) return null
    if (!isTerminal(run.status)) {
      sawLive = true
      if (signal?.aborted || Date.now() >= deadline) return toRunState(run)
      await backoff(deadline)
      continue
    }
    if (run.postHooksDone || !sawLive || recordWaitMs <= 0) return toRunState(run)
    if (!hold) {
      hold = { until: Date.now() + recordWaitMs, last: run }
      delay = POLL_MIN_MS // the backoff so far was the run's; the record is milliseconds away
    }
    hold.last = run
    if (Date.now() >= hold.until || signal?.aborted) return toRunState(run)
    await backoff(hold.until)
  }
}

/**
 * The wire body of a stored run. An ended run says one thing about its record: the sums once the post hooks delivered,
 * `costPending` before that, `recordFailed` when the runtime gave up. Never a cost of `null` for a record that is not
 * there: `null` means the run priced nothing.
 */
export function toRunState(run: StoredRun): RunState {
  const { cost, unpricedCalls, postHooksDone, postHooksFailed, ...state } = run
  if (!isTerminal(run.status)) return state
  if (!postHooksDone) return { ...state, costPending: true }
  if (postHooksFailed) return { ...state, recordFailed: true }
  return { ...state, cost, unpricedCalls }
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

/**
 * The run state's `output` is `z.unknown()` on the wire (a stored run of an older version must still be readable), so
 * the generated document would leave the workflow's output untyped. The workflow's own output schema is written into
 * the document here instead, which is where `agw schema <workflow>` reads it.
 *
 * The document is built at boot, so a problem throws there rather than shipping an untyped or dangling schema: the 200
 * response must be an inline object schema with properties (a `$ref` to a component would be overwritten wrongly), and
 * the output schema must inline completely (`reused: 'inline'`, `cycles: 'throw'`): a `$defs` or `$ref` of its own
 * would point into the output property, not the document.
 */
export function withOutputType<T extends { responses?: Record<string, unknown> }>(
  operation: T,
  workflow: { id: string; output: z.ZodType },
): T {
  const response = operation.responses?.['200'] as
    | { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
    | undefined
  const json = response?.content?.['application/json']
  if (!response || !json?.schema?.properties) {
    throw new Error(
      `workflow ${workflow.id}: the generated 200 response is not an inline object schema, so its output type cannot be written into it`,
    )
  }
  const { $schema: _, ...schema } = z.toJSONSchema(workflow.output, {
    io: 'output',
    unrepresentable: 'any',
    reused: 'inline',
    cycles: 'throw',
  })
  if (/"\$(ref|defs)"/.test(JSON.stringify(schema))) {
    throw new Error(
      `workflow ${workflow.id}: its output schema produced $ref or $defs, which would dangle in the document`,
    )
  }
  const typed = { ...schema, description: schema.description ?? "The workflow's output, once done" }
  return {
    ...operation,
    responses: {
      ...operation.responses,
      '200': {
        ...response,
        content: {
          ...response.content,
          'application/json': {
            ...json,
            schema: { ...json.schema, properties: { ...json.schema.properties, output: typed } },
          },
        },
      },
    },
  }
}

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
      operationId: workflowOperationId(workflow.id),
      summary: entry.summary ?? `Run ${workflow.id}`,
      tags: ['workflows'],
      spec: (operation) => withCli(cli)(withAccepted(withOutputType(operation, workflow), headers)),
    })
    .input(input.strict()) // an unknown key is a 400, never silently dropped
    .output(RunStateSchema)
    .handler(async ({ input, context, signal }) => {
      const wait = preferWait(context.headers)
      const { runId } = await startRun(deps, workflow, input, context.headers)
      // The run exists from here on: a failed read must still report its id, or a retry starts a second run.
      const state = await waitFor({
        store: deps.store,
        runId,
        seconds: wait,
        logger: deps.logger,
        signal,
        recordWaitMs: RECORD_WAIT_MS,
      }).catch((error: unknown) => {
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
      async handler({ input, context, signal }) {
        // a pure read: the record as it is, never a hold
        const run = await deps.store.get(input.runId)
        if (!run) throw notFound(input.runId)
        return respond(context, toRunState(run))
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
        const state = await waitFor({
          store: deps.store,
          runId: input.runId,
          seconds: preferWait(context.headers),
          logger: deps.logger,
          signal,
          recordWaitMs: RECORD_WAIT_MS,
        })
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
        const state = await waitFor({
          store: deps.store,
          runId: input.runId,
          seconds: wait,
          logger: deps.logger,
          signal,
        })
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
    operationId: workflowOperationId(workflow.id),
    method: 'POST',
    path,
    cli,
    procedure: buildWorkflow(entry, input, deps, cli, path),
  }
}
