import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { runawayCap, walletGate } from '@agent-workflows/limits'
import { fsFingerprintSource, platformMiddleware } from '@agent-workflows/middleware'
import { type AgentHost, Runtime } from '@agent-workflows/runtime'
import { Pool } from 'pg'
import { unwiredAgentHost } from './agent-host.ts'
import { createHost } from './app.ts'
import type { HostConfig } from './config.ts'
import { IDLE_TIMEOUT_S } from './operations.ts'
import { pgRunStore } from './store.ts'
import { createWorkflows } from './workflows/index.ts'

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

  const registry = createRegistry(createCapabilities())
  const workflows = createWorkflows(registry)

  const platform = platformMiddleware({
    connectionString: config.pgUrl,
    schema: config.schema,
    fingerprint: fsFingerprintSource({
      agentsDir: config.agentsDir ?? 'agents',
      workflows: {},
      opencodeBin: config.opencodeBin,
    }),
    telemetry: { exporter: exporterFor(env) },
    argo: { machine: config.machine },
  })
  const cap = runawayCap({ connectionString: config.pgUrl, schema: config.schema })
  const wallet = walletGate({ workflows: OPTIONAL_EXPENSIVE })
  const runtime = new Runtime({
    connectionString: config.pgUrl,
    schema: config.schema,
    workflows: workflows.map((entry) => entry.workflow),
    host: options.agentHost ?? unwiredAgentHost,
    middleware: [...platform.middleware, wallet, cap],
  })

  const pool = new Pool({
    connectionString: config.pgUrl,
    max: 4,
    application_name: `agw-host:${config.schema}`,
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  })
  pool.on('error', (err) => console.warn('[agw-host] pool: idle connection error', err.message))
  const store = pgRunStore({ pool, schema: config.schema })

  let open = false
  const host = createHost({
    runtime,
    registry,
    workflows,
    store,
    secret: config.secret,
    version: config.version,
    isOpen: () => open,
  })
  await host.openapi() // fails the start on a broken contract instead of the first request

  await runtime.open()
  open = true
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

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: host.fetch,
  })

  let stopping: Promise<void> | undefined
  const shutdown = () =>
    (stopping ??= (async () => {
      open = false
      clearInterval(flushTimer)
      // Stop accepting; give held `Prefer: wait` requests a moment to answer, then cut them (the CLI resumes).
      await Promise.race([server.stop(), Bun.sleep(SHUTDOWN_GRACE_MS)])
      await server.stop(true)
      await runtime.close()
      await cap.close()
      await platform.close()
      await pool.end()
    })())

  return { port: server.port ?? config.port, shutdown }
}
