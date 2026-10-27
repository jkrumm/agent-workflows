import { readdir } from 'node:fs/promises'
import type { Pool } from 'pg'
import { lockKey } from './lease.ts'

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url)
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

export function assertSchemaName(schema: string) {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
}

/**
 * Applies the numbered `migrations/*.sql` files not yet in `schema_migrations`, all in one transaction under
 * an advisory lock, so concurrent processes migrate once.
 */
export async function migrate(pool: Pool, schema: string): Promise<string[]> {
  assertSchemaName(schema)
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1::bigint)', [lockKey(`agw-migrate:${schema}`)])
    await client.query(`create schema if not exists "${schema}"`)
    await client.query(
      `create table if not exists "${schema}".schema_migrations (
        version text primary key, applied_at timestamptz not null default now())`,
    )
    const { rows } = await client.query<{ version: string }>(`select version from "${schema}".schema_migrations`)
    const applied = new Set(rows.map((r) => r.version))
    const pending = files.filter((f) => !applied.has(f))
    for (const file of pending) {
      const sql = await Bun.file(new URL(file, MIGRATIONS_DIR)).text()
      await client.query(sql.replaceAll('{{schema}}', `"${schema}"`))
      await client.query(`insert into "${schema}".schema_migrations (version) values ($1)`, [file])
    }
    await client.query('commit')
    return pending
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
