import type { Logger, Middleware } from '@agent-workflows/runtime'
import { JournalDb } from './db.ts'
import { type FrictionSource, frictionMiddleware } from './friction.ts'
import { type IuKeyId, iuKeyMiddleware } from './iu-key.ts'
import { type FingerprintSource, fingerprintMiddleware } from './fingerprint.ts'
import { purposeMiddleware } from './purpose.ts'
import { recordMiddleware } from './record.ts'
import { Telemetry, type TelemetryOptions } from './telemetry.ts'
import { type OutboxOptions, type UsageTransport, UsageOutbox, usageTransportFromEnv } from './usage.ts'

export type PlatformOptions = {
  /** The runtime's connection string and schema: the middleware writes the run-record columns of its journal. */
  connectionString: string
  schema?: string
  logger?: Logger
  fingerprint: FingerprintSource
  /** Where an agent step's session counters come from (the agent host); without one only step outcomes are counted. */
  friction?: FrictionSource
  /** The label of the IU key this process holds (`parseIuKeyId(IU_KEY_ID)`), stamped on every run it admits. Required: no silent default. */
  iuKey: IuKeyId
  telemetry?: Omit<TelemetryOptions, 'logger' | 'sessionIdOf'>
  /**
   * Where usage rows go. Default: the `usage` schema behind `USAGE_PG_URL` (`usageTransportFromEnv`), whose pool this
   * platform then owns and closes. Null: no outbox; steps stay unsynced in the journal until one runs. A transport
   * passed in stays its caller's to close.
   */
  usage?: { transport?: UsageTransport | null } & Pick<
    OutboxOptions,
    'machine' | 'batchSize' | 'backoff' | 'now' | 'postTimeoutMs' | 'claimTtlMs' | 'chunkSize'
  >
}

export type Platform = {
  /** For `new Runtime({ middleware })`, in this order. */
  middleware: Middleware[]
  telemetry: Telemetry
  /** `flush()` from the host's tick; null without a usage transport. */
  outbox: UsageOutbox | null
  /** Ends open spans as suspended, flushes, closes the pool. After `runtime.close()`. */
  close(): Promise<void>
}

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-middleware] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-middleware] ${message}`, meta ?? ''),
}

/**
 * The platform layer every workflow runs inside: purpose, IU key label, fingerprint, run record, telemetry (list order: friction
 * writes the counters the record reads; the record annotates the run span before telemetry ends it), plus the usage outbox the host flushes.
 */
export function platformMiddleware(options: PlatformOptions): Platform {
  const logger = options.logger ?? consoleLogger
  const db = new JournalDb({ connectionString: options.connectionString, schema: options.schema, poolSize: 2 }, logger)
  const telemetry = new Telemetry({ ...options.telemetry, logger })
  const ownsTransport = options.usage?.transport === undefined
  const transport = ownsTransport ? usageTransportFromEnv(logger) : options.usage?.transport
  if (!transport) logger.warn('usage outbox off: USAGE_PG_URL unset; usage stays unsynced in the journal')
  // Its own pool: a slow or hanging usage database can never starve the record's writes.
  const outboxDb = transport
    ? new JournalDb({ connectionString: options.connectionString, schema: options.schema, poolSize: 2 }, logger)
    : null
  const outbox = transport && outboxDb ? new UsageOutbox({ ...options.usage, db: outboxDb, transport, logger }) : null
  return {
    middleware: [
      purposeMiddleware(),
      iuKeyMiddleware({ db, logger, iuKey: options.iuKey }),
      fingerprintMiddleware({
        db,
        source: options.fingerprint,
        onFingerprint: (runId, fingerprint) => telemetry.annotateRun(runId, { 'agw.fingerprint': fingerprint }),
      }),
      frictionMiddleware({ db, logger, source: options.friction }),
      recordMiddleware({ db, logger, onRecord: (record) => telemetry.recordRun(record) }),
      telemetry.middleware(),
    ],
    telemetry,
    outbox,
    async close() {
      await telemetry.shutdown()
      await outbox?.close()
      if (ownsTransport) await transport?.close?.()
      await db.close()
      await outboxDb?.close()
    },
  }
}
