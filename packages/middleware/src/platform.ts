import type { Logger, Middleware } from '@agent-workflows/runtime'
import { type ArgoTransport, ArgoOutbox, argoTransportFromEnv, type OutboxOptions } from './argo.ts'
import { JournalDb } from './db.ts'
import { type FingerprintSource, fingerprintMiddleware } from './fingerprint.ts'
import { purposeMiddleware } from './purpose.ts'
import { recordMiddleware } from './record.ts'
import { Telemetry, type TelemetryOptions } from './telemetry.ts'

export type PlatformOptions = {
  /** The runtime's connection string and schema: the middleware writes the run-record columns of its journal. */
  connectionString: string
  schema?: string
  logger?: Logger
  fingerprint: FingerprintSource
  telemetry?: Omit<TelemetryOptions, 'logger' | 'sessionIdOf'>
  /** Default: `argoTransportFromEnv()`. Null: no outbox; steps stay unsynced in Postgres until one runs. */
  argo?: { transport?: ArgoTransport | null } & Pick<
    OutboxOptions,
    'machine' | 'billing' | 'batchSize' | 'backoff' | 'now' | 'postTimeoutMs' | 'claimTtlMs'
  >
}

export type Platform = {
  /** For `new Runtime({ middleware })`, in this order. */
  middleware: Middleware[]
  telemetry: Telemetry
  /** `flush()` from the host's tick; null without an Argo transport. */
  outbox: ArgoOutbox | null
  /** Ends open spans as suspended, flushes, closes the pool. After `runtime.close()`. */
  close(): Promise<void>
}

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-middleware] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-middleware] ${message}`, meta ?? ''),
}

/**
 * The platform layer every workflow runs inside: purpose, fingerprint, run record, telemetry (list order: the
 * record annotates the run span before telemetry ends it), plus the Argo outbox the host flushes.
 */
export function platformMiddleware(options: PlatformOptions): Platform {
  const logger = options.logger ?? consoleLogger
  const db = new JournalDb({ connectionString: options.connectionString, schema: options.schema, poolSize: 2 }, logger)
  const telemetry = new Telemetry({ ...options.telemetry, logger })
  const transport = options.argo?.transport === undefined ? argoTransportFromEnv() : options.argo.transport
  if (!transport) logger.warn('argo outbox off: ARGO_URL or ARGO_API_SECRET unset; usage stays unsynced in Postgres')
  // Its own pool: a slow or hanging Argo can never starve the record's writes.
  const outboxDb = transport
    ? new JournalDb({ connectionString: options.connectionString, schema: options.schema, poolSize: 2 }, logger)
    : null
  const outbox = transport && outboxDb ? new ArgoOutbox({ ...options.argo, db: outboxDb, transport, logger }) : null
  return {
    middleware: [
      purposeMiddleware(),
      fingerprintMiddleware({
        db,
        source: options.fingerprint,
        onFingerprint: (runId, fingerprint) => telemetry.annotateRun(runId, { 'agw.fingerprint': fingerprint }),
      }),
      recordMiddleware({ db, logger, onRecord: (record) => telemetry.recordRun(record) }),
      telemetry.middleware(),
    ],
    telemetry,
    outbox,
    async close() {
      await telemetry.shutdown()
      await db.close()
      await outboxDb?.close()
    },
  }
}
