import type { Ledger } from './ledger.ts'
import type { Logger } from './log.ts'
import { errorMessage } from './log.ts'
import type { Outbox } from './outbox.ts'
import type { Pools } from './pools/index.ts'
import type { GatewayProxy } from './proxy.ts'
import type { Reconciler } from './reconcile.ts'
import type { Telemetry } from './telemetry.ts'

/** Bun's cap per idle connection; every proxied request turns it off for itself. */
const IDLE_TIMEOUT_S = 255
/** Above `sttMaxUploadBytes`: the transcription door's uploads pass through here too. */
const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024

// SIGTERM to exit stays under the 60 s the deploy contract gives: drain, flush, spans.
const DRAIN_MS = 50_000
const FLUSH_MS = 5000
const SPANS_MS = 2000

export interface GatewayServerOptions {
  port: number
  proxy: GatewayProxy
  pools: Pools
  ledger: Ledger
  /** null: `USAGE_PG_URL` is unset. */
  outbox: Outbox | null
  reconciler: Reconciler
  telemetry: Telemetry
  logger: Logger
  version: string
  build: string
  /** Quarantined rows this process put back at start. */
  requeuedAtStart?: number
  drainMs?: number
}

export interface GatewayServer {
  port: number
  /** Stops accepting, lets streams finish, flushes, closes the ledger. Resolves within 60 s. */
  shutdown(): Promise<void>
}

const within = async (ms: number, work: Promise<unknown>): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([work.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function startGateway(options: GatewayServerOptions): GatewayServer {
  const { proxy, pools, ledger, outbox, reconciler, telemetry, logger } = options
  let closing = false

  const health = (): Response => {
    const writeError = ledger.degraded()
    let stats: ReturnType<Ledger['stats']> | { error: string }
    try {
      stats = ledger.stats()
    } catch (error) {
      stats = { error: errorMessage(error) }
    }
    return Response.json({
      status: writeError === null && !('error' in stats) ? 'ok' : 'degraded',
      version: options.version,
      build: options.build,
      pools: pools.status().map((pool) => ({ ...pool, ...reconciler.status(pool.id) })),
      ledger: {
        ...stats,
        requeuedAtStart: options.requeuedAtStart ?? 0,
        flush: outbox === null ? 'off' : 'on',
        ...(outbox?.lastError() ? { flushError: outbox.lastError() } : {}),
        ...(writeError === null ? {} : { writeError }),
      },
    })
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    idleTimeout: IDLE_TIMEOUT_S,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    async fetch(request, bunServer) {
      const { pathname } = new URL(request.url)
      if (pathname === '/health') return health()
      if (closing) {
        return Response.json(
          { type: 'error', error: { type: 'api_error', message: 'gateway is shutting down' } },
          { status: 503, headers: { connection: 'close' } },
        )
      }
      const response = await proxy.handle(request, bunServer)
      return (
        response ??
        Response.json(
          { type: 'error', error: { type: 'not_found_error', message: 'not found' } },
          {
            status: 404,
          },
        )
      )
    },
    error(error) {
      logger.error('request failed', { error: error.message })
      return Response.json({ type: 'error', error: { type: 'api_error', message: 'gateway error' } }, { status: 500 })
    },
  })

  return {
    port: server.port as number,
    async shutdown() {
      closing = true
      void server.stop(false)
      reconciler.stop()
      if (!(await within(options.drainMs ?? DRAIN_MS, proxy.drained()))) {
        logger.warn('shutdown: cutting the streams still open')
        proxy.abortAll()
      }
      if (outbox !== null) {
        await within(FLUSH_MS, outbox.flush())
        void outbox.close().catch(() => {})
      }
      await within(SPANS_MS, telemetry.shutdown())
      void server.stop(true)
      ledger.close()
    },
  }
}
