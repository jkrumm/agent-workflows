import { Pool } from 'pg'
import { Runtime, type RuntimeOptions } from '../../src/index.ts'
import type { Logger } from '../../src/types.ts'

/** Tests need a real Postgres; an unset URL is a loud failure, never a skip. */
export function testPgUrl(): string {
  const url = process.env.AGW_TEST_PG_URL
  if (!url) {
    throw new Error(
      'AGW_TEST_PG_URL is not set. Run the tests through `make check` (it resolves the mini database via secrets-run) or set it to a Postgres URL whose role may create schemas.',
    )
  }
  return url
}

export const PG_URL = testPgUrl()

/** A throwaway schema per test file (random suffix), so CI, the merge train and parallel workers never collide. */
export function freshSchema(prefix: string): { schema: string; drop(): Promise<void> } {
  const schema = `agw_t_${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
  return {
    schema,
    drop: async () => {
      const pool = new Pool({ connectionString: PG_URL, max: 1 })
      try {
        await pool.query(`drop schema if exists "${schema}" cascade`)
      } finally {
        await pool.end()
      }
    },
  }
}

export type LogLine = { level: 'warn' | 'error'; message: string; meta?: Record<string, unknown> }

export function captureLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = []
  return {
    lines,
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta }),
  }
}

/** Fast ticks for tests. */
export function testRuntime(options: Omit<RuntimeOptions, 'connectionString'> & { schema: string }): Runtime {
  return new Runtime({
    connectionString: PG_URL,
    recoveryIntervalMs: 100,
    watchIntervalMs: 50,
    infraBackoffMs: 100,
    journalPoolSize: 4,
    maxConcurrentRuns: 8,
    ...options,
  })
}

/** Direct SQL for assertions on the journal. */
export function inspector(schema: string) {
  const pool = new Pool({ connectionString: PG_URL, max: 2 })
  return {
    pool,
    async run(id: string) {
      const { rows } = await pool.query(`select * from "${schema}".runs where id = $1`, [id])
      return rows[0] as Record<string, unknown> | undefined
    },
    async step(runId: string, stepId: string) {
      const { rows } = await pool.query(`select * from "${schema}".steps where run_id = $1 and step_id = $2`, [
        runId,
        stepId,
      ])
      return rows[0] as Record<string, unknown> | undefined
    },
    async steps(runId: string) {
      const { rows } = await pool.query(`select * from "${schema}".steps where run_id = $1 order by started_at`, [
        runId,
      ])
      return rows as Record<string, unknown>[]
    },
    close: () => pool.end(),
  }
}

/** Polls `check` until it returns a truthy value. */
export async function until<T>(check: () => T | Promise<T>, label: string, timeoutMs = 5000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}
