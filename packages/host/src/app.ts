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

const json = (status: number, code: string, message: string, data?: unknown) =>
  Response.json({ defined: true, code, status, message, ...(data === undefined ? {} : { data }) }, { status })

const unauthorized = () => {
  const response = json(401, 'UNAUTHORIZED', 'Missing or wrong bearer token')
  response.headers.set('www-authenticate', 'Bearer')
  return response
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

  for (const c of registry.capabilities) assertNoReservedFlags(`capability ${c.id}`, c.input)

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
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        store.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), options.healthTimeoutMs ?? 2000)
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
      const context: HostContext = { ...registry.requestContext, headers: prepared.headers, response: {} }
      const { response } = await handler.handle(prepared, { context })
      if (!response) return notFoundResponse()
      const status = context.response.status
      return status && status !== response.status && response.ok
        ? new Response(response.body, { status, headers: response.headers })
        : response
    } catch (error) {
      logger.error('request failed', { error: error instanceof Error ? error.message : String(error) })
      return errorResponse(error)
    }
  }

  return { fetch: serve, openapi: async () => (await build()).body }
}
