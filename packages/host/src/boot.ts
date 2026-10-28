import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { runawayCap, walletGate } from '@agent-workflows/limits'
import { fsFingerprintSource, platformMiddleware } from '@agent-workflows/middleware'
import { type AgentHost, Runtime } from '@agent-workflows/runtime'
import { unwiredAgentHost } from './agent-host.ts'
import { createHost } from './app.ts'
import type { HostConfig } from './config.ts'
import { IDLE_TIMEOUT_S } from './operations.ts'
import { createWorkflows, fingerprintWorkflows } from './workflows/index.ts'

/** Workflows declared optional-expensive: the wallet gate refuses them at admission (concept §4). None yet. */
const OPTIONAL_EXPENSIVE: string[] = []

const FLUSH_INTERVAL_MS = 30_000
const SHUTDOWN_GRACE_MS = 5000

export interface RunningHost {
  port: number
  /** Stop accepting, close the runtime (runs stay `running`), flush telemetry, release pools. Idempotent. */
  shutdown(): Promise<void>
}

export interface BootOptions {
  /** The OpenCode adapter once it is wired; until then agent steps fail with `agent host not wired`. */
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
    const workflows = createWorkflows(registry)

    const platform = platformMiddleware({
      connectionString: config.pgUrl,
      schema: config.schema,
      fingerprint: fsFingerprintSource({
        agentsDir: config.agentsDir ?? 'agents',
        workflows: fingerprintWorkflows(workflows),
        opencodeBin: config.opencodeBin,
      }),
      telemetry: { exporter: exporterFor(env) },
      argo: { machine: config.machine },
    })
    closers.push(() => platform.close())
    const cap = runawayCap({ connectionString: config.pgUrl, schema: config.schema })
    closers.push(() => cap.close())
    const wallet = walletGate({ workflows: OPTIONAL_EXPENSIVE })
    const runtime = new Runtime({
      connectionString: config.pgUrl,
      schema: config.schema,
      workflows: workflows.map((entry) => entry.workflow),
      host: options.agentHost ?? unwiredAgentHost,
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
      await Promise.race([server.stop(), Bun.sleep(SHUTDOWN_GRACE_MS)])
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
