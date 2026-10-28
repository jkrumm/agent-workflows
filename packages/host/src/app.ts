import {
  type Capability,
  errorResponse,
  notFoundResponse,
  operationIdOf,
  type RequestContext,
  type RouterNode,
} from '@agent-workflows/capabilities'
import type { Logger, Runtime } from '@agent-workflows/runtime'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { onError } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { assertSecret, bearerMatches } from './auth.ts'
import { CONTRACT_FIELD, contractSha } from './canonical.ts'
import { type CapabilityWorkflows, capabilityRuns } from './capability-runs.ts'
import {
  assertNoReservedFlags,
  type HostContext,
  type HostOperation,
  type HostWorkflow,
  runOperations,
  workflowOperation,
} from './operations.ts'
import { type RunStore, runtimeRunStore } from './store.ts'

/** What the host reads of a capability registry; any `createRegistry(...)` fits. */
interface RegistryLike {
  readonly capabilities: readonly Capability[]
  readonly router: RouterNode
  readonly requestContext: RequestContext
}

export interface HostOptions {
  runtime: Runtime
  registry: RegistryLike
  workflows: HostWorkflow[]
  /** The `cap.<id>` workflows direct capability calls run as; the runtime must have been given the same map. */
  capabilityWorkflows: CapabilityWorkflows
  /** Run state bodies and the `/health` probe. Default: the runtime's own read API. */
  store?: RunStore
  /** `AGW_API_SECRET`: at least 32 characters, else creation throws. */
  secret: string
  version: string
  /** False while the runtime is not open (before `open()`, after `close()`): `/health` is degraded and every other route is a 503. */
  isOpen?: () => boolean
  /** Upper bound of the Postgres probe behind `/health`. Default 2 s. */
  healthTimeoutMs?: number
  logger?: Logger
}

export interface Host {
  fetch: (request: Request) => Promise<Response>
  /** The OpenAPI 3.1 document of the process, `info['x-contract-sha']` included. Built once. */
  openapi: () => Promise<Record<string, unknown>>
}

type Document = Record<string, unknown>

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-host] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-host] ${message}`, meta ?? ''),
}

/** The host's own envelopes (auth, contract, readiness) are never `defined`: only errors a procedure declares are. */
const json = (status: number, code: string, message: string, data?: unknown) =>
  Response.json({ defined: false, code, status, message, ...(data === undefined ? {} : { data }) }, { status })

const unauthorized = () => {
  const response = json(401, 'UNAUTHORIZED', 'Missing or wrong bearer token')
  response.headers.set('www-authenticate', 'Bearer')
  return response
}

/** A handler's success status (only on a success) and extra headers (on every answer, errors included). */
function applyResponse(response: Response, { status, headers }: HostContext['response']): Response {
  const overrideStatus = status !== undefined && status !== response.status && response.ok
  if (!overrideStatus && !headers) return response
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers ?? {})) merged.set(name, value)
  return new Response(response.body, { status: overrideStatus ? status : response.status, headers: merged })
}

/** Every command (capabilities, workflows, run ops) is unique, and none is the prefix of another. */
function assertCommands(commands: { owner: string; command: string[] }[]) {
  for (const [i, a] of commands.entries()) {
    for (const b of commands.slice(i + 1)) {
      const [short, long] = a.command.length <= b.command.length ? [a, b] : [b, a]
      if (short.command.every((part, n) => part === long.command[n])) {
        throw new Error(
          `command collision: \`agw ${long.command.join(' ')}\` (${long.owner}) vs \`agw ${short.command.join(' ')}\` (${short.owner})`,
        )
      }
    }
  }
}

export function createHost(options: HostOptions): Host {
  assertSecret(options.secret)
  const { runtime, registry, secret } = options
  const store = options.store ?? runtimeRunStore(runtime)
  const logger = options.logger ?? consoleLogger
  const isOpen = options.isOpen ?? (() => true)

  const deps = { runtime, store, logger }
  const workflows = options.workflows.map((entry) => ({ entry, op: workflowOperation(entry, deps) }))
  const runs = runOperations(deps)
  // A direct capability call over HTTP is a one-step run; `boot` registers the same workflows with the runtime.
  const invoke = capabilityRuns(options.capabilityWorkflows, { ...deps, isOpen })

  for (const c of registry.capabilities) assertNoReservedFlags(`capability ${c.id}`, c.input)
  for (const c of registry.capabilities) {
    if (!options.capabilityWorkflows.has(c.id)) throw new Error(`capability ${c.id} has no cap.${c.id} workflow`)
  }

  const operations: { owner: string; op: Pick<HostOperation, 'operationId' | 'method' | 'path' | 'cli'> }[] = [
    ...registry.capabilities.map((c) => ({
      owner: `capability ${c.id}`,
      op: {
        operationId: operationIdOf(c.id),
        method: c.route.method as 'GET' | 'POST',
        path: c.route.path,
        cli: c.cli,
      },
    })),
    ...workflows.map(({ entry, op }) => ({ owner: `workflow ${entry.workflow.id}`, op })),
    ...Object.entries(runs).map(([name, op]) => ({ owner: `run ${name}`, op })),
  ]
  assertCommands(operations.map(({ owner, op }) => ({ owner, command: op.cli.command })))
  for (const key of ['operationId', 'path'] as const) {
    const seen = new Map<string, string>()
    for (const { owner, op } of operations) {
      const value = key === 'path' ? `${op.method} ${op.path}` : op.operationId
      const other = seen.get(value)
      if (other) throw new Error(`${key} collision: "${value}" is used by ${other} and ${owner}`)
      seen.set(value, owner)
    }
  }

  for (const reserved of ['workflows', 'runs']) {
    if (reserved in registry.router)
      throw new Error(`capability ids may not start with "${reserved}." (reserved by the host)`)
  }
  const router = {
    ...registry.router,
    workflows: Object.fromEntries(workflows.map(({ entry, op }) => [entry.workflow.id, op.procedure])),
    runs: Object.fromEntries(Object.entries(runs).map(([name, op]) => [name, op.procedure])),
  }
  const handler = new OpenAPIHandler(router as never, {
    interceptors: [
      onError((error) => {
        const cause = (error as { cause?: unknown }).cause ?? error
        if ((error as { status?: number }).status === 500 || !(error as { status?: number }).status) {
          logger.error('request failed', { error: cause instanceof Error ? cause.message : String(cause) })
        }
      }),
    ],
  })

  let document: Promise<{ body: Document; sha: string }> | undefined
  const build = () =>
    (document ??= (async () => {
      const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
      const body = (await generator.generate(router as never, {
        info: { title: 'agent-workflows host', version: options.version },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearer: [] }],
      })) as Document
      const sha = contractSha(body)
      body.info = { ...(body.info as object), [CONTRACT_FIELD]: sha }
      return { body, sha }
    })().catch((error: unknown) => {
      document = undefined // a failed build is retried, never cached
      throw error
    }))

  async function health(): Promise<Response> {
    const degraded = (reason: string) => Response.json({ status: 'degraded', reason }, { status: 503 })
    if (!isOpen()) return degraded('runtime is not open')
    const timeout = options.healthTimeoutMs ?? 2000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The store ends its own query at the bound; the race covers a store that cannot (and a hung fake).
      await Promise.race([
        store.ping(timeout),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeout)
        }),
      ])
    } catch {
      return degraded('postgres does not answer')
    } finally {
      clearTimeout(timer)
    }
    return Response.json({ status: 'ok', version: options.version })
  }

  /**
   * `{}` is implied for a workflow started with no body (`agw smoke ping`), and a body sent without a content type
   * is read as JSON; a body that is there is never replaced, so validation runs on what the client sent.
   */
  async function withJsonBody(request: Request, pathname: string): Promise<Request> {
    if (request.method !== 'POST' || !pathname.startsWith('/workflows/')) return request
    const text = await request.text()
    const headers = new Headers(request.headers)
    headers.set('content-type', 'application/json')
    return new Request(request.url, {
      method: request.method,
      headers,
      body: text.trim() === '' ? '{}' : text,
      signal: request.signal,
    })
  }

  async function serve(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/health') return health()
    if (!bearerMatches(request.headers.get('authorization'), secret)) return unauthorized()
    if (!isOpen()) return json(503, 'SERVICE_UNAVAILABLE', 'The runtime is not open')

    try {
      const { body, sha } = await build()
      if (request.method === 'GET' && pathname === '/openapi.json') return Response.json(body)

      const client = request.headers.get('x-agw-contract')
      if (client !== null && client !== sha) {
        return json(412, 'CONTRACT_MISMATCH', 'The client was generated from a different contract', {
          server: sha,
          client,
        })
      }

      const prepared = await withJsonBody(request, pathname)
      const context: HostContext = {
        ...registry.requestContext,
        headers: prepared.headers,
        response: {},
        invoke: (capability, input, signal) => invoke({ capability, input, signal, context }),
      }
      const { response } = await handler.handle(prepared, { context })
      if (!response) return notFoundResponse()
      return applyResponse(response, context.response)
    } catch (error) {
      logger.error('request failed', { error: error instanceof Error ? error.message : String(error) })
      return errorResponse(error)
    }
  }

  return { fetch: serve, openapi: async () => (await build()).body }
}
