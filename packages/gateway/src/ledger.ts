import { Database } from 'bun:sqlite'
import type { MeterSource } from './pools/index.ts'

/** Rows the outbox has written stay this long, then go; the meter never reads further back than a cycle (31 days). */
const RETENTION_MS = 62 * 24 * 60 * 60 * 1000

/** One `usage.records` row as the gateway writes it (`source='gateway'`, one per served request). */
export interface RecordRow {
  source: 'gateway'
  /** The gateway's request id, a uuidv7. */
  source_id: string
  grain: 'message'
  ts: string
  model_raw: string | null
  model: string | null
  billing: 'api_credit' | 'api_key'
  /** The credit pool, for `api_credit`. */
  account: string | null
  /** The IU key label, for `api_key`. */
  api_key: 'personal' | null
  machine: string
  outcome: 'ok' | 'error'
  lane: 'agw_workflow' | 'hermes' | 'other'
  lane_detail: Record<string, unknown> & { pool: string }
  run_id: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_5m_tokens: number
  cache_write_1h_tokens: number
  reasoning_tokens: number
  duration_ms: number
  /** Priced from a complete reported usage block; null when there is none (Postgres then prices the token columns). */
  cost_reported_usd: number | null
  raw: Record<string, unknown>
}

/** One `usage.gateway_picks` row: a routing decision. */
export interface PickRow {
  ts: string
  caller: string
  session: string | null
  /** A pool id, `iu-api` or `refused`. */
  picked: string
  reason: string
  machine: string
  request_id: string
}

export interface PendingBatch {
  records: { id: number; row: RecordRow }[]
  picks: { id: number; row: PickRow }[]
}

/** Ledger rows Postgres refused, by ledger id, with why. */
export interface Refusals {
  records: Map<number, string>
  picks: Map<number, string>
}

export interface LedgerStats {
  /** Rows (records and picks) waiting for the flush, quarantined ones not counted. */
  unsynced: number
  quarantined: number
  oldestUnsyncedAt: string | null
}

const SCHEMA = `
  create table if not exists records (
    id integer primary key,
    request_id text not null unique,
    pool text not null,
    usd real, -- what the meter charged, an estimate included
    written_at_ms integer not null,
    row_json text not null,
    synced_at_ms integer,
    quarantine_error text
  );
  create index if not exists records_meter on records (pool, written_at_ms);
  create index if not exists records_outbox on records (id) where synced_at_ms is null and quarantine_error is null;
  create table if not exists picks (
    id integer primary key,
    request_id text not null,
    picked text not null,
    written_at_ms integer not null,
    row_json text not null,
    synced_at_ms integer,
    quarantine_error text,
    unique (request_id, picked)
  );
  create index if not exists picks_outbox on picks (id) where synced_at_ms is null and quarantine_error is null;
  create table if not exists reconcile_floors (
    pool text primary key,
    cycle_key text not null,
    usd real not null,
    at_ms integer not null
  );
  create table if not exists probe (id integer primary key check (id = 1), at_ms integer not null);
`

/** The last reconciled figure of a pool, and the instant it counts up to. */
export interface StoredFloor {
  usd: number
  at: Date
}

/** Where a reconciled figure outlives the process. */
export interface FloorStore {
  saveFloor(pool: string, cycleKey: string, floor: StoredFloor): void
  /** Null when the pool has no figure for this cycle. */
  floorOf(pool: string, cycleKey: string): StoredFloor | null
}

type Stored = { id: number; row_json: string }

/**
 * The gateway's durable record of what it served, on local disk: the outbox (a synchronous write per row, flushed to
 * Postgres later, so a crash or a Postgres outage loses nothing) and the meter's source (`spentSince`, synced or not, so
 * the meter survives a restart without Postgres). `written_at_ms` is the instant the meter works with: `pools.charge`
 * takes the same instant as `rowAt`.
 */
export class Ledger implements MeterSource, FloorStore {
  private readonly db: Database
  private readonly now: () => number
  private lastWriteError: string | null = null

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    // NORMAL in WAL mode: durable across a process crash, the failure the outbox guards; a power cut may lose the last
    // rows, and the hourly reconcile restores the meter from the cost report.
    this.db.run('pragma synchronous = normal')
    // A second connection (sqlite3 on the file, a checkpoint) must wait, not fail a write. Never a second gateway.
    this.db.run('pragma busy_timeout = 5000')
    this.db.run(SCHEMA)
  }

  /**
   * Writes one served request, synchronously; returns the row's instant. `chargeUsd` is what the meter counts, an
   * estimate included, which the row's own cost never carries. Throws when it cannot (and health degrades).
   */
  writeRecord(row: RecordRow, chargeUsd: number | null = row.cost_reported_usd): Date {
    return this.writing(() => {
      const at = this.now()
      this.db
        .query(
          `insert into records (request_id, pool, usd, written_at_ms, row_json)
           values ($id, $pool, $usd, $at, $json)`,
        )
        .run({
          id: row.source_id,
          pool: row.lane_detail.pool,
          usd: chargeUsd,
          at,
          json: JSON.stringify(row),
        })
      return new Date(at)
    })
  }

  /** Writes one routing decision; a repeat of the same `(request_id, picked)` is ignored. */
  writePick(row: PickRow): void {
    this.writing(() => {
      this.db
        .query(
          `insert into picks (request_id, picked, written_at_ms, row_json) values ($id, $picked, $at, $json)
           on conflict (request_id, picked) do nothing`,
        )
        .run({ id: row.request_id, picked: row.picked, at: this.now(), json: JSON.stringify(row) })
    })
  }

  /** USD recorded for a pool since an instant, synced or not. The passthrough's label `iu-api` is not pool `iu`. */
  spentSince(pool: string, since: Date): number {
    const row = this.db
      .query<{ usd: number | null }, { pool: string; since: number }>(
        'select sum(usd) as usd from records where pool = $pool and written_at_ms >= $since',
      )
      .get({ pool, since: since.getTime() })
    return row?.usd ?? 0
  }

  saveFloor(pool: string, cycleKey: string, floor: StoredFloor): void {
    this.db
      .query(
        `insert into reconcile_floors (pool, cycle_key, usd, at_ms) values ($pool, $key, $usd, $at)
         on conflict (pool) do update set cycle_key = excluded.cycle_key, usd = excluded.usd, at_ms = excluded.at_ms`,
      )
      .run({ pool, key: cycleKey, usd: floor.usd, at: floor.at.getTime() })
  }

  floorOf(pool: string, cycleKey: string): StoredFloor | null {
    const row = this.db
      .query<{ usd: number; at_ms: number }, { pool: string; key: string }>(
        'select usd, at_ms from reconcile_floors where pool = $pool and cycle_key = $key',
      )
      .get({ pool, key: cycleKey })
    return row === null ? null : { usd: row.usd, at: new Date(row.at_ms) }
  }

  /** The oldest rows the outbox still owes, up to `limit` per table. */
  pending(limit: number): PendingBatch {
    const read = (table: 'records' | 'picks') =>
      this.db
        .query<Stored, { limit: number }>(
          `select id, row_json from ${table} where synced_at_ms is null and quarantine_error is null
           order by id limit $limit`,
        )
        .all({ limit })
    return {
      records: read('records').map(({ id, row_json }) => ({ id, row: JSON.parse(row_json) as RecordRow })),
      picks: read('picks').map(({ id, row_json }) => ({ id, row: JSON.parse(row_json) as PickRow })),
    }
  }

  /** Closes a flushed batch in one transaction: refused rows are quarantined with the error, the others are synced. */
  settle(batch: PendingBatch, refused: Refusals): void {
    const at = this.now()
    const settleRows = (table: 'records' | 'picks', rows: { id: number }[], errors: Map<number, string>) => {
      for (const { id } of rows) {
        const error = errors.get(id)
        if (error === undefined) {
          this.db.query(`update ${table} set synced_at_ms = $at where id = $id`).run({ at, id })
        } else {
          this.db
            .query(`update ${table} set quarantine_error = $error where id = $id`)
            .run({ error: error.slice(0, 1000), id })
        }
      }
    }
    this.db.transaction(() => {
      settleRows('records', batch.records, refused.records)
      settleRows('picks', batch.picks, refused.picks)
    })()
  }

  /**
   * Puts quarantined rows back into the outbox; returns the count. Called once per process start: a migration or a
   * deploy may have fixed what Postgres refused, and a row that still fails is quarantined again until the next start.
   */
  requeueQuarantined(): number {
    const requeue = (table: 'records' | 'picks') =>
      this.db.run(`update ${table} set quarantine_error = null where quarantine_error is not null`).changes
    return this.db.transaction(() => requeue('records') + requeue('picks'))()
  }

  /** Drops synced rows older than the retention; unsynced and quarantined rows stay. Returns the count. */
  prune(): number {
    const before = this.now() - RETENTION_MS
    const drop = (table: 'records' | 'picks') =>
      this.db.query(`delete from ${table} where synced_at_ms is not null and written_at_ms < $before`).run({ before })
        .changes
    return drop('records') + drop('picks')
  }

  stats(): LedgerStats {
    const count = (table: 'records' | 'picks', where: string) =>
      this.db
        .query<{ n: number; oldest: number | null }, []>(
          `select count(*) as n, min(written_at_ms) as oldest from ${table} where ${where}`,
        )
        .get() ?? { n: 0, oldest: null }
    const owed = 'synced_at_ms is null and quarantine_error is null'
    const records = count('records', owed)
    const picks = count('picks', owed)
    const oldest = Math.min(records.oldest ?? Infinity, picks.oldest ?? Infinity)
    return {
      unsynced: records.n + picks.n,
      quarantined:
        count('records', 'quarantine_error is not null').n + count('picks', 'quarantine_error is not null').n,
      oldestUnsyncedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    }
  }

  /** The last write failed and a fresh probe write fails too: rows are not reaching the disk. */
  degraded(): string | null {
    if (this.lastWriteError === null) return null
    try {
      this.writing(() => {
        this.db
          .query('insert into probe (id, at_ms) values (1, $at) on conflict (id) do update set at_ms = excluded.at_ms')
          .run({ at: this.now() })
      })
    } catch {
      // `writing` kept the error.
    }
    return this.lastWriteError
  }

  /** One integer pragma of this connection; `synchronous` is per connection, so only this one can tell. */
  pragma(name: 'synchronous'): number | undefined {
    return this.db.query<Record<string, number>, []>(`pragma ${name}`).get()?.[name]
  }

  close(): void {
    this.db.close()
  }

  private writing<T>(write: () => T): T {
    try {
      const result = write()
      this.lastWriteError = null
      return result
    } catch (error) {
      this.lastWriteError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
}
