import { Pool } from 'pg'
import type { Logger } from '@agent-workflows/runtime'

export type DbOptions = {
  /** The runtime's connection string. */
  connectionString: string
  /** The runtime's journal schema. Default `agw`. */
  schema?: string
  /** Default 2: the middleware's writes are one statement per run or step. */
  poolSize?: number
}

/** The run and step tables of the runtime's journal, on a small pool of the middleware's own. */
export class JournalDb {
  readonly pool: Pool
  readonly runs: string
  readonly steps: string

  constructor(options: DbOptions, logger: Logger) {
    const schema = options.schema ?? 'agw'
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
    this.runs = `"${schema}".runs`
    this.steps = `"${schema}".steps`
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 2,
      application_name: `agw-middleware:${schema}`,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    })
    this.pool.on('error', (err) => logger.warn('middleware pool: idle connection error', { error: err.message }))
  }

  close(): Promise<void> {
    return this.pool.end()
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Retries a statement on a transient failure; a post hook that throws is logged and never re-delivered. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, backoffMs = 200): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts) throw err
      await Bun.sleep(backoffMs * 2 ** (i - 1))
    }
  }
}
