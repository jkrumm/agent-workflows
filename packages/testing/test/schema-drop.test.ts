import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { Pool } from 'pg'
import { SCHEMA_PREFIX, schemaCreatedAt, schemaName, sweepStaleSchemas } from '../src/sweep.ts'

const DAY = 24 * 3_600_000
const packages = new URL('../../', import.meta.url).pathname

describe('test schema names', () => {
  test('carry their creation time, to the second', () => {
    const at = Date.UTC(2026, 10, 16, 8, 0, 0)
    const name = schemaName('mw', at)
    expect(name.startsWith(`${SCHEMA_PREFIX}mw_`)).toBe(true)
    expect(schemaCreatedAt(name)).toBe(at)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  test('a name without a timestamp, or not ours, has no age', () => {
    expect(schemaCreatedAt('agw_t_prose_9840b14d75')).toBeNull()
    expect(schemaCreatedAt('public')).toBeNull()
    expect(schemaCreatedAt('other_1789200000_9840b14d75')).toBeNull()
  })
})

describe('every file that makes a schema drops it', () => {
  test('freshSchema callers call drop()', async () => {
    const offenders: string[] = []
    for await (const file of new Glob('*/test/**/*.test.ts').scan({ cwd: packages })) {
      const text = await Bun.file(`${packages}${file}`).text()
      if (/\bfreshSchema\(/.test(text) && !/\.drop\(\)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('sweep', () => {
  const url = process.env.AGW_TEST_PG_URL

  test.skipIf(!url)('drops schemas older than the cutoff, keeps younger ones and names without a time', async () => {
    const now = Date.now()
    const old = schemaName('sweepold', now - 2 * DAY)
    const young = schemaName('sweepyoung', now - 3_600_000)
    const legacy = `${SCHEMA_PREFIX}sweeplegacy_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
    const pool = new Pool({ connectionString: url, max: 1 })
    const exists = async (schema: string) =>
      (await pool.query('select 1 from information_schema.schemata where schema_name = $1', [schema])).rowCount === 1
    try {
      for (const schema of [old, young, legacy]) await pool.query(`create schema "${schema}"`)
      await sweepStaleSchemas(url as string, { nowMs: now })
      expect([await exists(old), await exists(young), await exists(legacy)]).toEqual([false, true, true])
    } finally {
      for (const schema of [old, young, legacy]) await pool.query(`drop schema if exists "${schema}" cascade`)
      await pool.end()
    }
  })
})
