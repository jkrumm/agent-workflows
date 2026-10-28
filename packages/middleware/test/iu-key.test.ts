import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow, type RunPreArgs } from '@agent-workflows/runtime'
import { z } from 'zod'
import { isIuKeyId, iuKeyMiddleware, JournalDb, parseIuKeyId } from '../src/index.ts'
import { captureLogger, FakeArgo, freshSchema, inspector, PG_URL, testPlatform, testRuntime, until } from './support.ts'

const db = freshSchema('mwk')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const n = z.object({ n: z.number() })
const work = defineWorkflow({
  id: 'k.work',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('work', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
      return n
    })
    return { n }
  },
})

describe('parseIuKeyId', () => {
  test('unset, empty and the two ids', () => {
    const warnings: string[] = []
    const warn = (m: string) => warnings.push(m)
    expect(parseIuKeyId(undefined, warn)).toBe('personal')
    expect(parseIuKeyId('', warn)).toBe('personal')
    expect(parseIuKeyId('  ', warn)).toBe('personal')
    expect(parseIuKeyId('personal', warn)).toBe('personal')
    expect(parseIuKeyId(' athena-team ', warn)).toBe('athena-team')
    expect(warnings).toEqual([])
  })

  test('anything else is personal plus one warning that never echoes the value', () => {
    const warnings: string[] = []
    expect(parseIuKeyId('sk-not-an-id', (m) => warnings.push(m))).toBe('personal')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('sk-not-an-id')
  })
})

/** Runs `work` once under `starter`'s middleware, waits for its record, returns the run id. */
async function runUnder(starter: ReturnType<typeof testPlatform>, middleware = starter.middleware): Promise<string> {
  const rt = testRuntime({ schema: db.schema, workflows: [work], middleware })
  await rt.open()
  try {
    const { runId } = await rt.start(work, { n: 1 }, { purpose: 'build' })
    await rt.wait(runId)
    await until(async () => (await sql.run(runId))?.post_hooks_at, 'runPost')
    return runId
  } finally {
    await rt.close()
  }
}

describe('isIuKeyId', () => {
  test('only the two ids', () => {
    expect(isIuKeyId('personal') && isIuKeyId('athena-team')).toBe(true)
    expect([isIuKeyId('x'), isIuKeyId(''), isIuKeyId(null), isIuKeyId(undefined)]).toEqual([false, false, false, false])
  })
})

describe('iu_key on Argo rows', () => {
  test('the run keeps the label of the host that started it; a flush under another key does not change it', async () => {
    const started = testPlatform(db.schema, { iuKey: 'athena-team' })
    const runId = await runUnder(started)
    await started.close()
    expect((await sql.run(runId))?.iu_key).toBe('athena-team')

    // A restarted host that holds the personal key flushes the outbox.
    const argo = new FakeArgo()
    const flusher = testPlatform(db.schema, { iuKey: 'personal', argo: { transport: argo, machine: 'm' } })
    try {
      await flusher.outbox?.flush()
    } finally {
      await flusher.close()
    }
    const rows = [...argo.stored.values()].filter((r) => r.source_id.startsWith(`${runId}:`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ billing: 'iu', iu_key: 'athena-team', account: null })
    expect(JSON.stringify(rows[0]?.raw)).not.toMatch(/iu_?key|athena/i)
  })

  test('a billing other than iu carries iu_key null', async () => {
    const started = testPlatform(db.schema, { iuKey: 'athena-team' })
    const runId = await runUnder(started)
    await started.close()
    const argo = new FakeArgo()
    const flusher = testPlatform(db.schema, { argo: { transport: argo, machine: 'm2', billing: 'max' } })
    try {
      await flusher.outbox?.flush()
    } finally {
      await flusher.close()
    }
    const rows = [...argo.stored.values()].filter((r) => r.source_id.startsWith(`${runId}:`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ billing: 'max', iu_key: null })
  })

  test('a run row stored before the label existed reads as personal', async () => {
    const platform = testPlatform(db.schema, { iuKey: 'athena-team' })
    // No stamping middleware: the row keeps the column default, as every pre-migration row does.
    const runId = await runUnder(
      platform,
      platform.middleware.filter((m) => m.name !== 'iu-key'),
    )
    await platform.close()
    expect((await sql.run(runId))?.iu_key).toBe('personal')
    const argo = new FakeArgo()
    const flusher = testPlatform(db.schema, { iuKey: 'athena-team', argo: { transport: argo, machine: 'm3' } })
    try {
      await flusher.outbox?.flush()
    } finally {
      await flusher.close()
    }
    const rows = [...argo.stored.values()].filter((r) => r.source_id.startsWith(`${runId}:`))
    expect(rows[0]).toMatchObject({ iu_key: 'personal' })
  })

  test('a resumed run is not re-stamped by a host with another key', async () => {
    const platform = testPlatform(db.schema, { iuKey: 'athena-team' })
    const runId = await runUnder(platform)
    await platform.close()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger())
    try {
      const args = { runId, resume: true } as RunPreArgs
      await iuKeyMiddleware({ db: journal, logger: captureLogger(), iuKey: 'personal' }).runPre?.(args)
      expect((await sql.run(runId))?.iu_key).toBe('athena-team')
    } finally {
      await journal.close()
    }
  })

  test('a run row that does not exist is warned about, naming the run id', async () => {
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    try {
      await iuKeyMiddleware({ db: journal, logger, iuKey: 'athena-team' }).runPre?.({
        runId: 'run_missing',
        resume: false,
      } as RunPreArgs)
      expect(JSON.stringify(logger.lines)).toContain('run_missing')
    } finally {
      await journal.close()
    }
  })
})
