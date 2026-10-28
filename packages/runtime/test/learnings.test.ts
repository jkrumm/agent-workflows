import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { z } from 'zod'
import { migrate } from '../src/migrate.ts'
import { defineWorkflow } from '../src/index.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { captureLogger, freshSchema, inspector, PG_URL, testRuntime } from './support/pg.ts'

const db = freshSchema('learn')
const fresh = freshSchema('learnold')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
  await fresh.drop()
})

const failed = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    () => true,
  )
const MIGRATIONS = new URL('../src/migrations/', import.meta.url)

describe('0005_learnings migration', () => {
  test('a fresh schema gets the table with its constraints', async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const applied = await migrate(pool, db.schema)
      expect(applied).toContain('0005_learnings.sql')
      const t = `"${db.schema}".learnings`
      await pool.query(`insert into ${t} (agent, fact, source) values ('a', 'f', 'manual')`)
      const { rows } = await pool.query(`select status, retired_at from ${t}`)
      expect(rows[0]).toMatchObject({ status: 'proposed', retired_at: null })
      // retired_at and status agree
      expect(await failed(pool.query(`update ${t} set status = 'retired'`))).toBe(true)
      expect(
        await failed(pool.query(`insert into ${t} (agent, fact, source, status) values ('a','g','m','bogus')`)),
      ).toBe(true)
      // one copy of a fact per agent, retired rows included: a retired fact is not proposed again
      expect(await failed(pool.query(`insert into ${t} (agent, fact, source) values ('a', 'f', 'manual')`))).toBe(true)
      await pool.query(`update ${t} set status = 'retired', retired_at = now()`)
      expect(await failed(pool.query(`insert into ${t} (agent, fact, source) values ('a', 'f', 'run-2')`))).toBe(true)
      await pool.query(`insert into ${t} (agent, fact, source) values ('b', 'f', 'manual')`) // another agent may hold it
    } finally {
      await pool.end()
    }
  })

  test('an existing schema at 0003 with data migrates forward, keeping its runs', async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const schema = fresh.schema
      await pool.query(`create schema "${schema}"`)
      await pool.query(
        `create table "${schema}".schema_migrations (version text primary key, applied_at timestamptz not null default now())`,
      )
      const old = readdirSync(MIGRATIONS)
        .filter((f) => /^000[1-3]_/.test(f))
        .sort()
      expect(old).toHaveLength(3)
      for (const file of old) {
        await pool.query(readFileSync(new URL(file, MIGRATIONS), 'utf8').replaceAll('{{schema}}', `"${schema}"`))
        await pool.query(`insert into "${schema}".schema_migrations (version) values ($1)`, [file])
      }
      await pool.query(
        `insert into "${schema}".runs (id, workflow, root_id, purpose, input, input_hash, lock_key, version_started)
         values ('r1', 'w', 'r1', 'prod', '{}', 'h', 1, 'v1')`,
      )
      const applied = await migrate(pool, schema)
      expect(applied).toContain('0005_learnings.sql')
      expect(applied).not.toContain('0001_journal.sql')
      expect((await pool.query(`select id from "${schema}".runs`)).rows).toHaveLength(1)
      expect((await pool.query(`select count(*)::int as n from "${schema}".learnings`)).rows[0].n).toBe(0)
      expect(await migrate(pool, schema)).toEqual([]) // idempotent
    } finally {
      await pool.end()
    }
  })
})

describe('agentPrompt hook', () => {
  const answer = z.object({ answer: z.string() })
  const wf = (id: string) =>
    defineWorkflow({
      id,
      version: 'v1',
      input: z.object({}),
      output: answer,
      run: (ctx) => ctx.agent('ask', { agent: 'helper', prompt: 'what?', output: answer }),
    })

  const add = wf('hook.add')
  const boom = wf('hook.throw')

  test('the host session gets the hook result in open and in the prompt; the step spec is untouched', async () => {
    const host = new FakeAgentHost(async (s) => ({ output: { answer: s.spec.prompt } }))
    const calls: { agent: string; prompt: string }[] = []
    const rt = testRuntime({
      schema: db.schema,
      workflows: [add],
      host,
      agentPrompt: ({ agent, prompt }) => {
        calls.push({ agent, prompt })
        return `${prompt}\n\nextra`
      },
    })
    await rt.open()
    try {
      const { runId } = await rt.start(add, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'what?\n\nextra' })
      expect(calls).toEqual([{ agent: 'helper', prompt: 'what?' }])
    } finally {
      await rt.close()
    }
  })

  test('the step tail stays last: the hook sees the prompt without it', async () => {
    const tailed = defineWorkflow({
      id: 'hook.tail',
      version: 'v1',
      input: z.object({}),
      output: answer,
      run: (ctx) => ctx.agent('ask', { agent: 'helper', prompt: 'what?', tail: '\n\nJSON only.', output: answer }),
    })
    const host = new FakeAgentHost(async (s) => ({ output: { answer: s.spec.prompt } }))
    const seen: string[] = []
    const rt = testRuntime({
      schema: db.schema,
      workflows: [tailed],
      host,
      agentPrompt: ({ prompt }) => {
        seen.push(prompt)
        return `${prompt}\n\nfacts`
      },
    })
    await rt.open()
    try {
      const { runId } = await rt.start(tailed, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'what?\n\nfacts\n\nJSON only.' })
      expect(seen).toEqual(['what?'])
    } finally {
      await rt.close()
    }
  })

  test('a throwing hook is logged and the original prompt is sent', async () => {
    const host = new FakeAgentHost(async (s) => ({ output: { answer: s.spec.prompt } }))
    const logger = captureLogger()
    const rt = testRuntime({
      schema: db.schema,
      workflows: [boom],
      host,
      logger,
      agentPrompt: () => {
        throw new Error('db down')
      },
    })
    await rt.open()
    try {
      const { runId } = await rt.start(boom, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'what?' })
      expect(logger.lines.some((l) => l.level === 'error' && l.message.includes('agentPrompt hook failed'))).toBe(true)
    } finally {
      await rt.close()
    }
  })
})
