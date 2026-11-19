import { Pool } from 'pg'

/**
 * Throwaway test schemas: `agw_t_<prefix>_<creation epoch seconds>_<10 hex>`. The creation time is in the name because
 * Postgres keeps none for a schema, and the sweep must go by age: a concurrent run (another agent's `make check`) owns
 * its schemas until they are a day old, whatever the name pattern.
 */
export const SCHEMA_PREFIX = 'agw_t_'
const SWEEP_MAX_AGE_MS = 24 * 3_600_000

const CREATED = /_(\d{10})_[0-9a-f]{10}$/

export function schemaName(prefix: string, nowMs = Date.now()): string {
  const rand = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  return `${SCHEMA_PREFIX}${prefix}_${Math.floor(nowMs / 1000)}_${rand}`
}

/** When a test schema was created (ms), or null for a name without a timestamp (not ours to judge). */
export function schemaCreatedAt(name: string): number | null {
  if (!name.startsWith(SCHEMA_PREFIX)) return null
  const seconds = CREATED.exec(name)?.[1]
  return seconds === undefined ? null : Number(seconds) * 1000
}

/**
 * Drops every `agw_t_*` schema created more than `maxAgeMs` ago. Best effort: one schema failing to drop (a lock held by
 * a still-running process) is counted and skipped, never thrown. Returns what it dropped and what it could not.
 */
export async function sweepStaleSchemas(
  connectionString: string,
  options: { maxAgeMs?: number; nowMs?: number } = {},
): Promise<{ dropped: number; failed: number }> {
  const cutoff = (options.nowMs ?? Date.now()) - (options.maxAgeMs ?? SWEEP_MAX_AGE_MS)
  const pool = new Pool({ connectionString, max: 1 })
  let dropped = 0
  let failed = 0
  try {
    const { rows } = await pool.query<{ schema_name: string }>(
      'select schema_name from information_schema.schemata where starts_with(schema_name, $1)',
      [SCHEMA_PREFIX],
    )
    for (const { schema_name } of rows) {
      const created = schemaCreatedAt(schema_name)
      if (created === null || created >= cutoff) continue
      try {
        await pool.query(`drop schema if exists "${schema_name}" cascade`)
        dropped++
      } catch {
        failed++
      }
    }
  } finally {
    await pool.end()
  }
  return { dropped, failed }
}

// `bun packages/testing/src/sweep.ts`, run by `make check` before the tests. It never fails the run.
if (import.meta.main) {
  const url = process.env.AGW_TEST_PG_URL
  if (!url) {
    console.error('sweep: AGW_TEST_PG_URL is not set; nothing swept')
  } else {
    try {
      const { dropped, failed } = await sweepStaleSchemas(url)
      console.log(
        `sweep: dropped ${dropped} test schema(s) older than a day${failed ? `, ${failed} could not be dropped` : ''}`,
      )
    } catch (err) {
      console.error(`sweep: skipped (${err instanceof Error ? err.message : String(err)})`)
    }
  }
}
