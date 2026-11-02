import { DatabaseError, Pool, type PoolClient } from 'pg'
import type { Ledger, PendingBatch, PickRow, RecordRow, Refusals } from './ledger.ts'
import { errorMessage, type Logger } from './log.ts'

const FLUSH_INTERVAL_MS = 30_000
const DEBOUNCE_MS = 1000
const BATCH_ROWS = 200
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Takes a batch atomically; a refused row comes back, anything else (an outage, a missing table) throws. */
export interface UsageSink {
  write(batch: PendingBatch): Promise<Refusals>
  close(): Promise<void>
}

/** Columns a re-flush may change; mirrors `RECORD_UPSERT` of packages/middleware/src/usage.ts. */
const RECORD_COLUMNS = [
  'grain',
  'ts',
  'model_raw',
  'model',
  'billing',
  'account',
  'api_key',
  'machine',
  'outcome',
  'lane',
  'lane_detail',
  'run_id',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'reasoning_tokens',
  'duration_ms',
  'cost_reported_usd',
  'cost_usd',
  'cost_source',
  'price_id',
  'raw',
  'repo',
  'project_raw',
  'workspace',
] as const

// `cost_usd` is priced in the statement, by the database, as for every other writer: the reported figure wins.
const RECORD_UPSERT = `
  insert into usage.records (source, source_id, ${RECORD_COLUMNS.join(', ')})
  select $1::text, $2::text, $3::text, $4::timestamptz, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text,
    $11::text, $12::text, $13::jsonb, $14::text, $15::bigint, $16::bigint, $17::bigint, $18::bigint, $19::bigint,
    $20::bigint, $21::integer, $22::numeric, c.cost_usd, c.cost_source, c.price_id, $23::jsonb,
    $24::text, $25::text, $26::text
  from usage.compute_cost($6::text, $4::timestamptz, $15::bigint, $16::bigint, $17::bigint, $18::bigint, $19::bigint,
    $20::bigint, 'message', $22::numeric) c
  on conflict (source, source_id) do update set
    ${RECORD_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}
  where (${RECORD_COLUMNS.map((c) => `usage.records.${c}`).join(', ')})
    is distinct from (${RECORD_COLUMNS.map((c) => `excluded.${c}`).join(', ')})`

const PICK_UPSERT = `
  insert into usage.gateway_picks (ts, caller, session, picked, reason, machine, request_id)
  values ($1::timestamptz, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text)
  on conflict (request_id, picked) do nothing`

const recordParams = (r: RecordRow): unknown[] => [
  r.source,
  r.source_id,
  r.grain,
  r.ts,
  r.model_raw,
  r.model,
  r.billing,
  r.account,
  r.api_key,
  r.machine,
  r.outcome,
  r.lane,
  JSON.stringify(r.lane_detail),
  r.run_id,
  r.input_tokens,
  r.output_tokens,
  r.cache_read_tokens,
  r.cache_write_5m_tokens,
  r.cache_write_1h_tokens,
  r.reasoning_tokens,
  r.duration_ms,
  r.cost_reported_usd,
  JSON.stringify(r.raw),
  r.repo,
  r.project_raw,
  r.workspace,
]

const pickParams = (p: PickRow): unknown[] => [p.ts, p.caller, p.session, p.picked, p.reason, p.machine, p.request_id]

/** SQLSTATE class 22 (data exception) or 23 (integrity constraint): the row itself is the problem, retrying cannot help. */
const isRowRefusal = (error: unknown): error is DatabaseError =>
  error instanceof DatabaseError && /^2[23]/.test(error.code ?? '')

/** A database error that leaves the connection unusable (as packages/middleware/src/usage.ts `connectionLost`). */
const connectionLost = (error: DatabaseError): boolean =>
  /^(08|57P)/.test(error.code ?? '') || error.severity === 'FATAL' || error.severity === 'PANIC'

/**
 * `usage.records` and `usage.gateway_picks` in one transaction. The common batch goes straight through; a row refusal
 * rolls it back and replays it with a savepoint per row, so the bad row comes back and the others commit.
 */
export function pgUsageSink(options: { connectionString: string; logger: Logger }): UsageSink {
  const pool = new Pool({
    connectionString: options.connectionString,
    // The `usage` role's connection limit is shared with usage-tracker; one flusher needs one.
    max: 1,
    application_name: 'agw-gateway',
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
  })
  pool.on('error', (error) => options.logger.warn('usage pool: idle connection error', { error: error.message }))

  const rowsOf = (batch: PendingBatch) => [
    ...batch.records.map(({ id, row }) => ({ table: 'records', id, sql: RECORD_UPSERT, params: recordParams(row) })),
    ...batch.picks.map(({ id, row }) => ({ table: 'picks', id, sql: PICK_UPSERT, params: pickParams(row) })),
  ]

  const refusalOf = async (client: PoolClient, sql: string, params: unknown[]): Promise<string | null> => {
    await client.query('savepoint row')
    try {
      await client.query(sql, params)
      await client.query('release savepoint row')
      return null
    } catch (error) {
      if (!isRowRefusal(error)) throw error
      await client.query('rollback to savepoint row')
      await client.query('release savepoint row')
      return `${error.code} ${error.message}`
    }
  }

  const transaction = async (client: PoolClient, body: () => Promise<void>): Promise<void> => {
    await client.query('begin')
    try {
      await body()
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
  }

  const write = async (client: PoolClient, batch: PendingBatch): Promise<Refusals> => {
    const refused: Refusals = { records: new Map(), picks: new Map() }
    const rows = rowsOf(batch)
    try {
      await transaction(client, async () => {
        for (const { sql, params } of rows) await client.query(sql, params)
      })
      return refused
    } catch (error) {
      if (!isRowRefusal(error)) throw error
    }
    await transaction(client, async () => {
      for (const { table, id, sql, params } of rows) {
        const refusal = await refusalOf(client, sql, params)
        if (refusal !== null) (table === 'records' ? refused.records : refused.picks).set(id, refusal)
      }
    })
    return refused
  }

  return {
    async write(batch) {
      let broken = false
      const onClientError = (error: Error) => {
        broken = true
        options.logger.warn('usage flush: connection error', { error: error.message })
      }
      const client = await pool.connect()
      client.on('error', onClientError)
      try {
        return await write(client, batch)
      } catch (error) {
        broken ||= !(error instanceof DatabaseError) || connectionLost(error)
        throw error
      } finally {
        client.off('error', onClientError)
        client.release(broken)
      }
    },
    close: () => pool.end(),
  }
}

/**
 * Delivers the ledger to Postgres at least once: every 30 s and soon after each write, one flush at a time. A row is
 * marked only after its transaction committed, so a crash in between re-flushes it, and the upserts absorb the repeat. A
 * row Postgres refuses is quarantined (kept in the ledger, counted on /health, never retried). Any other failure leaves
 * everything unsynced; after one, only the 30 s tick retries, so an outage is not hammered per request.
 */
export class Outbox {
  private readonly ledger: Ledger
  private readonly sink: UsageSink
  private readonly logger: Logger
  private readonly intervalMs: number
  private readonly debounceMs: number
  private readonly batchRows: number
  private timer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private next: Promise<void> | null = null
  private failing = false
  private lastPruneMs = 0
  private error: string | null = null

  constructor(options: {
    ledger: Ledger
    sink: UsageSink
    logger: Logger
    intervalMs?: number
    debounceMs?: number
    batchRows?: number
  }) {
    this.ledger = options.ledger
    this.sink = options.sink
    this.logger = options.logger
    this.intervalMs = options.intervalMs ?? FLUSH_INTERVAL_MS
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.batchRows = options.batchRows ?? BATCH_ROWS
  }

  /** The first flush runs now: what a crash left behind goes out at boot. */
  start(): void {
    void this.flush()
    this.timer = setInterval(() => void this.flush(), this.intervalMs)
    this.timer.unref()
  }

  /** A row was written: flush soon. */
  poke(): void {
    if (this.failing || this.timer === null || this.debounce !== null) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.flush()
    }, this.debounceMs)
    this.debounce.unref()
  }

  /** Never rejects. With a flush in flight, one more runs after it: a row written after its read goes out too. */
  flush(): Promise<void> {
    if (this.inflight !== null) {
      this.next ??= this.inflight.then(() => {
        this.next = null
        return this.flush()
      })
      return this.next
    }
    this.inflight = this.drain().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  lastError(): string | null {
    return this.error
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.timer = null
    this.debounce = null
  }

  /** Stops the timers, waits for what is in flight, and closes the sink. */
  async close(): Promise<void> {
    this.stop()
    await this.inflight
    await this.sink.close()
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const batch = this.ledger.pending(this.batchRows)
        if (batch.records.length === 0 && batch.picks.length === 0) break
        const refused = await this.sink.write(batch)
        this.ledger.settle(batch, refused)
        for (const [table, errors] of [
          ['records', refused.records],
          ['picks', refused.picks],
        ] as const) {
          for (const [id, error] of errors) {
            this.logger.error('usage flush: row quarantined; the rest keep flowing', { table, id, error })
          }
        }
        if (batch.records.length < this.batchRows && batch.picks.length < this.batchRows) break
      }
      this.failing = false
      this.error = null
      this.prune()
    } catch (error) {
      this.error = errorMessage(error)
      if (!this.failing) this.logger.warn('usage flush failed; rows stay in the ledger', { error: this.error })
      this.failing = true
    }
  }

  private prune(): void {
    const at = Date.now()
    if (at - this.lastPruneMs < PRUNE_INTERVAL_MS) return
    this.lastPruneMs = at
    const pruned = this.ledger.prune()
    if (pruned > 0) this.logger.info('ledger pruned', { rows: pruned })
  }
}
