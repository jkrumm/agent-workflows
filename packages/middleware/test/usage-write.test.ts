import { describe, expect, test } from 'bun:test'
import type { PoolClient } from 'pg'
import { type UsageRow, UsageOutbox, usageRowsForStep, writeBatch } from '../src/index.ts'
import { captureLogger } from './support.ts'

// writeBatch against a recording client: what the transaction issues and in which order, and what happens when the
// rollback itself fails. The real-database behaviour (server-side deadlines, terminated backends) is in usage-pg.test.ts.

type Call = { sql: string; params: unknown[] }

function fakeClient(options: { failOn?: (sql: string) => Error | null } = {}) {
  const calls: Call[] = []
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      const failure = options.failOn?.(sql)
      if (failure) throw failure
      return { rows: [], rowCount: 0 }
    },
  } as unknown as PoolClient
  return { client, calls }
}

const startedAt = new Date('2026-10-27T10:00:00.000Z')

function rowOf(runId: string, stepId: string): UsageRow {
  const [row] = usageRowsForStep(
    {
      runId,
      stepId,
      status: 'done',
      model: 'm1',
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: 0.001,
      toolCalls: 0,
      unpricedCalls: 0,
      byModel: null,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1000),
      sessionId: null,
      run: {
        workflowId: 'w',
        rootId: runId,
        purpose: 'build',
        iuKey: 'personal',
        traceparent: null,
        traceId: null,
        fingerprint: null,
        friction: null,
        status: 'done',
        errorKind: null,
        wallMs: 1000,
      },
    },
    { machine: 'm' },
  )
  return row as UsageRow
}

const noop = { timeoutMs: 1000, onBroken: () => {} }
const sessionsWritten = (calls: Call[]) =>
  calls.filter((c) => c.sql.includes('insert into usage.sessions')).map((c) => c.params[1])
const recordsWritten = (calls: Call[]) =>
  calls.filter((c) => c.sql.includes('insert into usage.records')).map((c) => c.params[1])

describe('writeBatch', () => {
  test('sessions and records are issued sorted by key, whatever the batch order', async () => {
    const rows = [rowOf('run_c', 'b'), rowOf('run_a', 'z'), rowOf('run_b', 'a'), rowOf('run_a', 'a')]
    const { client, calls } = fakeClient()
    await writeBatch(client, rows, noop)
    expect(sessionsWritten(calls)).toEqual(['run_a', 'run_b', 'run_c'])
    expect(recordsWritten(calls)).toEqual(['run_a:a:m1', 'run_a:z:m1', 'run_b:a:m1', 'run_c:b:m1'])
    // The caller's array is not reordered.
    expect(rows.map((r) => r.source_id)[0]).toBe('run_c:b:m1')
  })

  test('begins first and sets the transaction deadlines inside it, before any write', async () => {
    const { client, calls } = fakeClient()
    await writeBatch(client, [rowOf('run_a', 'a')], { timeoutMs: 8000, onBroken: () => {} })
    expect(calls[0]?.sql).toBe('begin')
    expect(calls[1]?.sql).toContain('transaction_timeout')
    expect(calls[1]?.sql).toContain('statement_timeout')
    expect(calls[1]?.sql).toContain('lock_timeout')
    expect(calls[1]?.params).toEqual(['8000', '4000'])
    expect(calls.at(-1)?.sql).toBe('commit')
  })

  test('a failing statement is rolled back and rethrown; the client stays trusted', async () => {
    let broken = false
    const boom = new Error('statement failed')
    const { client, calls } = fakeClient({ failOn: (sql) => (sql.includes('usage.records') ? boom : null) })
    expect(
      await writeBatch(client, [rowOf('run_a', 'a')], { timeoutMs: 1000, onBroken: () => (broken = true) }).catch(
        (e: unknown) => e,
      ),
    ).toBe(boom)
    expect(calls.at(-1)?.sql).toBe('rollback')
    expect(broken).toBe(false)
  })

  test('a failing rollback marks the client broken and still throws the original error', async () => {
    let broken = false
    const original = new Error('statement failed')
    const { client } = fakeClient({
      failOn: (sql) =>
        sql.includes('usage.records') ? original : sql === 'rollback' ? new Error('rollback failed') : null,
    })
    expect(
      await writeBatch(client, [rowOf('run_a', 'a')], { timeoutMs: 1000, onBroken: () => (broken = true) }).catch(
        (e: unknown) => e,
      ),
    ).toBe(original)
    expect(broken).toBe(true)
  })

  test('a failing begin is inside the try: rolled back, broken when that fails too', async () => {
    let broken = false
    const { client, calls } = fakeClient({
      failOn: (sql) => (sql === 'begin' || sql === 'rollback' ? new Error(`${sql} failed`) : null),
    })
    expect(
      await writeBatch(client, [rowOf('run_a', 'a')], { timeoutMs: 1000, onBroken: () => (broken = true) }).catch(
        (e: unknown) => e,
      ),
    ).toMatchObject({ message: 'begin failed' })
    expect(calls.map((c) => c.sql)).toEqual(['begin', 'rollback'])
    expect(broken).toBe(true)
  })
})

describe('outbox and transport deadlines', () => {
  test('postTimeoutMs must exceed the transport write deadline', () => {
    const transport = { writeTimeoutMs: 20_000, write: async () => {} }
    expect(
      () =>
        new UsageOutbox({
          db: {} as never,
          transport,
          logger: captureLogger(),
          machine: 'm',
          postTimeoutMs: 20_000,
          claimTtlMs: 120_000,
        }),
    ).toThrow(/writeTimeoutMs/)
  })
})
