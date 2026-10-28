import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { startFakeIu, messageResponse, type FakeIuServer } from '@agent-workflows/capabilities/testing'
import { iuTransports } from '@agent-workflows/capabilities'
import { defineWorkflow, type Logger, type Runtime } from '@agent-workflows/runtime'
import { Pool } from 'pg'
import { z } from 'zod'
import { createHost, type Host } from '../src/app.ts'
import type { HostWorkflow } from '../src/operations.ts'
import { type RunStore, runtimeRunStore } from '../src/store.ts'
import { createSmokePing } from '../src/workflows/smoke.ts'
import { FakeArgo, testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, PG_URL, testRuntime } from '../../runtime/test/support/pg.ts'

export { captureLogger, freshSchema, inspector, PG_URL, until } from '../../runtime/test/support/pg.ts'

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
export type Body = Record<string, any>

export const SECRET = 'test-secret-0123456789abcdef-0123456789'

/** A step the test holds open until `release()`; it honours the step's signal like a real body must. */
/** The message a promise rejects with; fails the test when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error.message
}

export function gate() {
  const g = {
    released: Promise.resolve(),
    release: () => {},
    /** Closes the gate again: the next `hold.open` step waits. */
    reset() {
      g.released = new Promise<void>((resolve) => {
        g.release = resolve
      })
    },
  }
  g.reset()
  return g
}

export function testWorkflows(g = gate()) {
  const echo = defineWorkflow({
    id: 'echo.say',
    version: 'v1',
    input: z.object({ text: z.string().default('hello') }),
    output: z.object({ text: z.string() }),
    run: async (ctx, { text }) => ({ text: await ctx.step('say', () => text) }),
  })
  const hold = defineWorkflow({
    id: 'hold.open',
    version: 'v1',
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    async run(ctx) {
      await ctx.step('hold', ({ signal }) =>
        Promise.race([
          g.released,
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        ]).then(() => true),
      )
      return { done: true }
    },
  })
  const boom = defineWorkflow({
    id: 'boom.fail',
    version: 'v1',
    input: z.object({}),
    output: z.object({}),
    async run(ctx) {
      await ctx.step('explode', () => {
        throw new Error('boom')
      })
      return {}
    },
  })
  const nothing = defineWorkflow({
    id: 'nothing.null',
    version: 'v1',
    input: z.object({}),
    output: z.null(),
    run: async () => null,
  })
  const entries: HostWorkflow[] = [
    { workflow: nothing },
    { workflow: echo, cli: { positional: ['text'] } },
    { workflow: hold },
    { workflow: boom, cli: { mutating: true } },
  ]
  return { entries, gate: g }
}

export type TestHost = Awaited<ReturnType<typeof startTestHost>>

export async function startTestHost(
  options: {
    prefix?: string
    secret?: string
    isOpen?: () => boolean
    extra?: HostWorkflow[]
    iu?: FakeIuServer
    ping?: () => Promise<void>
    healthTimeoutMs?: number
    wrapStore?: (store: RunStore) => RunStore
    logger?: Logger
    /** Runs behind the platform middleware with an in-memory Argo, as in production. */
    platform?: boolean
  } = {},
) {
  const fresh = freshSchema(options.prefix ?? 'host')
  const { schema } = fresh
  const iu =
    options.iu ??
    startFakeIu({
      messages: () =>
        messageResponse('A Smoke Title', {
          input_tokens: 40,
          output_tokens: 6,
          cache_read_input_tokens: 10,
          cost: 0.0007,
        }),
    })
  const registry = createRegistry(
    createCapabilities({
      transports: iuTransports({ env: { IU_API_KEY: 'test-key', IU_BASE_URL: iu.baseUrl }, backoffMs: 0 }),
      env: {},
    }),
  )
  const held = testWorkflows()
  const workflows = [createSmokePing(registry), ...held.entries, ...(options.extra ?? [])]
  const argo = new FakeArgo()
  const platform = options.platform
    ? testPlatform(schema, { argo: { transport: argo, machine: 'test-machine' } })
    : null
  const runtime: Runtime = testRuntime({
    schema,
    workflows: workflows.map((w) => w.workflow),
    middleware: platform?.middleware,
  })
  await runtime.open()
  const pool = new Pool({ connectionString: PG_URL, max: 2 })
  const realStore = runtimeRunStore(runtime)
  const pinged = options.ping ? { ...realStore, ping: options.ping } : realStore
  const store = options.wrapStore ? options.wrapStore(pinged) : pinged
  let open = true
  const close = async () => {
    open = false
    await runtime.close()
    await platform?.close()
    iu.stop()
    await pool.end()
    await fresh.drop()
  }
  let host: Host
  try {
    host = createHost({
      runtime,
      registry,
      workflows,
      store,
      logger: options.logger,
      secret: options.secret ?? SECRET,
      version: '1.2.3',
      isOpen: options.isOpen ?? (() => open),
      healthTimeoutMs: options.healthTimeoutMs,
    })
  } catch (error) {
    await close()
    throw error
  }

  const call = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown; auth?: string | null } = {},
  ) => {
    const headers: Record<string, string> = { ...init.headers }
    if (init.auth !== null) headers.authorization = `Bearer ${init.auth ?? SECRET}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    return host.fetch(
      new Request(`http://127.0.0.1:7791${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    )
  }
  const json = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Body,
  })

  return {
    host,
    registry,
    runtime,
    iu,
    argo,
    platform,
    gate: held.gate,
    schema,
    pool,
    call,
    json,
    close,
  }
}
