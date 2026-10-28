import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { runawayCap, walletGate } from '@agent-workflows/limits'
import { fsFingerprintSource, platformMiddleware } from '@agent-workflows/middleware'
import { OpenCodeHost, OpenCodeServer } from '@agent-workflows/opencode-host'
import { type AgentHost, type Json, Runtime } from '@agent-workflows/runtime'
import { loadAgentDefinitions } from './agents.ts'
import { createHost } from './app.ts'
import type { HostConfig } from './config.ts'
import { IDLE_TIMEOUT_S } from './operations.ts'
import { createWorkflows, fingerprintWorkflows } from './workflows/index.ts'

const FLUSH_INTERVAL_MS = 30_000
const SHUTDOWN_GRACE_MS = 5000

export interface RunningHost {
  port: number
  /** Stop accepting, close the runtime (runs stay `running`), flush telemetry, release pools. Idempotent. */
  shutdown(): Promise<void>
}

export interface BootOptions {
  /** Replaces the OpenCode host (tests). */
  agentHost?: AgentHost
  env?: Record<string, string | undefined>
}

type Exporter = NonNullable<NonNullable<Parameters<typeof platformMiddleware>[0]['telemetry']>['exporter']>

/** Export off without an endpoint: the default exporter would retry `localhost:4318` forever. */
const silentExporter: Exporter = {
  export: (_spans, done) => done({ code: 0 }),
  shutdown: async () => {},
}

function exporterFor(env: Record<string, string | undefined>): Exporter | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  return endpoint ? undefined : silentExporter
}

type AgentDefinitions = ConstructorParameters<typeof OpenCodeHost>[0]['agents']

export type LazyAgentHost = AgentHost & { close(): Promise<void> }

type OpenCodeTraceparent = NonNullable<ConstructorParameters<typeof OpenCodeHost>[0]['traceparent']>

/** What the lazy host needs from a server: `OpenCodeServer`, or a fake in tests. */
export type LazyServer = ConstructorParameters<typeof OpenCodeHost>[0]['server'] & {
  start(): Promise<void>
  close(): Promise<void>
}

export interface LazyOpenCodeOptions {
  /** Where locations and the server's state live. Default: the real state dir. Tests pass a temporary one. */
  stateDir?: string
  /** Builds the server on the first step. Default: a real `OpenCodeServer` on `stateDir`. */
  createServer?: () => LazyServer
  /** `close` waits this long for a start still in flight, then closes what exists. Default 5 s. */
  closeWaitMs?: number
  /** The agents the host serves (`agents/<name>/`). Default: none. */
  agents?: AgentDefinitions
}

/**
 * The OpenCode `AgentHost`, built on the first agent step: the server (and the host's maintenance timer) does not
 * exist at boot, so a host without agent workflows never spawns or probes `opencode`. A failed start is not cached,
 * so the next step retries. `close` stops supervising; the server keeps running for the next process (a deploy).
 */
export function lazyOpenCodeHost(
  env: Record<string, string | undefined>,
  traceparent: OpenCodeTraceparent,
  options: LazyOpenCodeOptions = {},
): LazyAgentHost {
  const { stateDir, closeWaitMs = 5000, agents = [] } = options
  const createServer = options.createServer ?? (() => new OpenCodeServer({ env, stateDir }))
  let built: Promise<{ server: LazyServer; host: OpenCodeHost }> | undefined
  let closed = false
  const get = () => {
    if (closed) return Promise.reject(new Error('opencode host is closed'))
    built ??= (async () => {
      const server = createServer()
      await server.start()
      if (closed) {
        // close() gave up waiting for this start; nothing else will ever stop supervising it.
        await server.close()
        throw new Error('opencode host is closed')
      }
      return { server, host: new OpenCodeHost({ server, agents, env, traceparent, stateDir }) }
    })().catch((error: unknown) => {
      built = undefined
      throw error
    })
    return built
  }
  return {
    open: async (spec) => (await get()).host.open(spec),
    prompt: async (handle: Json, prompt) => (await get()).host.prompt(handle, prompt),
    wait: async (handle: Json, options) => (await get()).host.wait(handle, options),
    steer: async (handle: Json, text, options) => (await get()).host.steer(handle, text, options),
    abort: async (handle: Json) => (await get()).host.abort(handle),
    async close() {
      closed = true
      if (!built) return
      const timeout = Bun.sleep(closeWaitMs).then(() => undefined)
      const ready = await Promise.race([built.catch(() => undefined), timeout])
      ready?.host.close()
      await ready?.server.close()
    },
  }
}

export async function boot(config: HostConfig, options: BootOptions = {}): Promise<RunningHost> {
  const env = options.env ?? process.env

  // Every resource registers its closer as it is created; a failure at any point runs the same teardown as a
  // signal does, in reverse order, so a half-started process never keeps pools, timers or leases.
  const closers: (() => Promise<void>)[] = []
  let closing: Promise<void> | undefined
  const shutdown = () =>
    (closing ??= (async () => {
      const failures: unknown[] = []
      for (const close of closers.toReversed()) {
        await close().catch((error: unknown) => {
          failures.push(error)
          console.error('[agw-host] close failed:', error instanceof Error ? error.message : error)
        })
      }
      if (failures.length > 0) throw failures[0]
    })())

  try {
    const registry = createRegistry(createCapabilities())
    const workflows = createWorkflows({ registry })
    const agentsDir = config.agentsDir ?? 'agents'
    const agents = loadAgentDefinitions(agentsDir)

    const platform = platformMiddleware({
      connectionString: config.pgUrl,
      schema: config.schema,
      fingerprint: fsFingerprintSource({
        agentsDir,
        workflows: fingerprintWorkflows(workflows),
        opencodeBin: config.opencodeBin,
      }),
      telemetry: { exporter: exporterFor(env) },
      argo: { machine: config.machine },
    })
    closers.push(() => platform.close())
    const owned = options.agentHost
      ? undefined
      : lazyOpenCodeHost(env, (runId, stepId) => platform.telemetry.traceparent(runId, stepId) ?? undefined, {
          agents,
        })
    const agentHost = options.agentHost ?? owned
    if (owned) closers.push(() => owned.close())
    const cap = runawayCap({ connectionString: config.pgUrl, schema: config.schema })
    closers.push(() => cap.close())
    // Optional expensive work (OCR) is its own workflow, refused at admission by the wallet gate (concept §4).
    const wallet = walletGate({
      workflows: workflows.filter((entry) => entry.optionalExpensive).map((entry) => entry.workflow.id),
    })
    const runtime = new Runtime({
      connectionString: config.pgUrl,
      schema: config.schema,
      workflows: workflows.map((entry) => entry.workflow),
      host: agentHost,
      middleware: [...platform.middleware, wallet, cap],
    })
    closers.push(() => runtime.close())

    // The journal reads behind the HTTP bodies go through the runtime's own pool (`runtime.getRun`): a poll is one
    // indexed primary-key read, backed off to 250 ms, so held waits cost the journal far less than the run writes.
    let open = false
    const host = createHost({
      runtime,
      registry,
      workflows,
      secret: config.secret,
      version: config.version,
      isOpen: () => open,
    })
    await host.openapi() // a broken contract fails the start, not the first request

    // Bind before the runtime opens: a taken port (a deploy overlap) must fail before any run is claimed.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: host.fetch,
    })
    closers.push(async () => {
      // Stop accepting; give held `Prefer: wait` requests a moment to answer, then cut them (the CLI resumes).
      const draining = server.stop().catch((error: unknown) => {
        console.error('[agw-host] graceful stop failed:', error instanceof Error ? error.message : error)
      })
      await Promise.race([draining, Bun.sleep(SHUTDOWN_GRACE_MS)])
      await server.stop(true)
    })

    await runtime.open()
    open = true
    closers.push(async () => {
      open = false
    })

    let flushing = false
    const flushTimer = setInterval(() => {
      if (flushing || !platform.outbox) return
      flushing = true
      platform.outbox
        .flush()
        .catch((err: unknown) =>
          console.error('[agw-host] outbox flush failed', err instanceof Error ? err.message : err),
        )
        .finally(() => {
          flushing = false
        })
    }, FLUSH_INTERVAL_MS)
    closers.push(async () => clearInterval(flushTimer))

    return { port: server.port ?? config.port, shutdown }
  } catch (error) {
    await shutdown().catch(() => {}) // already logged by the closer
    throw error
  }
}
