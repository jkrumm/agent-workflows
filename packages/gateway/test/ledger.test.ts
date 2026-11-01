import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { Ledger, type PickRow, type RecordRow } from '../src/ledger.ts'
import { Outbox, type UsageSink } from '../src/outbox.ts'
import { silentLogger, tempDir } from './support.ts'

export const recordRow = (id: string, over: Partial<RecordRow> = {}): RecordRow => ({
  source: 'gateway',
  source_id: id,
  grain: 'message',
  ts: '2026-11-01T10:00:00.000Z',
  model_raw: 'priced-model',
  model: 'priced-model',
  billing: 'api_credit',
  account: 'iu',
  api_key: null,
  machine: 'test-machine',
  outcome: 'ok',
  lane: 'other',
  lane_detail: { caller: 'oc', pool: 'iu' },
  run_id: null,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  reasoning_tokens: 0,
  duration_ms: 5,
  cost_reported_usd: 1,
  raw: {},
  ...over,
})

export const pickRow = (id: string, picked = 'iu', over: Partial<PickRow> = {}): PickRow => ({
  ts: '2026-11-01T10:00:00.000Z',
  caller: 'oc',
  session: 's',
  picked,
  reason: 'soonest-expiry',
  machine: 'test-machine',
  request_id: id,
  ...over,
})

const DAY = 86_400_000
const none = () => ({ records: new Map<number, string>(), picks: new Map<number, string>() })

let dir: ReturnType<typeof tempDir>
let ledger: Ledger
let clock = Date.parse('2026-11-01T12:00:00Z')

beforeEach(() => {
  dir = tempDir()
  clock = Date.parse('2026-11-01T12:00:00Z')
  ledger = new Ledger(join(dir.path, 'ledger.sqlite'), { now: () => clock })
})

afterEach(() => {
  ledger.close()
  dir.remove()
})

describe('ledger', () => {
  test('spentSince sums a pool from an instant, synced or not, and survives a reopen', () => {
    ledger.writeRecord(recordRow('a', { cost_reported_usd: 1.5 }))
    clock += DAY
    ledger.writeRecord(recordRow('b', { cost_reported_usd: 2.5 }))
    ledger.writeRecord(recordRow('c', { cost_reported_usd: null }))
    ledger.writeRecord(
      recordRow('d', {
        cost_reported_usd: 9,
        billing: 'api_key',
        account: null,
        api_key: 'personal',
        lane_detail: { pool: 'iu-api' },
      }),
    )
    const batch = ledger.pending(1)
    ledger.settle(batch, none())
    const midpoint = new Date(clock - DAY / 2)
    expect(ledger.spentSince('iu', new Date(0))).toBe(4)
    expect(ledger.spentSince('iu', midpoint)).toBe(2.5)
    expect(ledger.spentSince('me', new Date(0))).toBe(0)
    ledger.close()
    ledger = new Ledger(join(dir.path, 'ledger.sqlite'), { now: () => clock })
    expect(ledger.spentSince('iu', new Date(0))).toBe(4)
  })

  test('writeRecord returns the instant the meter charges with', () => {
    expect(ledger.writeRecord(recordRow('a')).getTime()).toBe(clock)
  })

  test('picks are keyed by (request_id, picked): a repeat is ignored, a re-pick is a row', () => {
    ledger.writePick(pickRow('r', 'iu'))
    ledger.writePick(pickRow('r', 'iu'))
    ledger.writePick(pickRow('r', 'iu-api', { reason: 'drained-retry' }))
    expect(ledger.pending(10).picks.map(({ row }) => row.picked)).toEqual(['iu', 'iu-api'])
  })

  test('stats: backlog, its age, quarantine', () => {
    expect(ledger.stats()).toEqual({ unsynced: 0, quarantined: 0, oldestUnsyncedAt: null })
    ledger.writeRecord(recordRow('a'))
    ledger.writePick(pickRow('a'))
    const oldest = new Date(clock).toISOString()
    clock += 1000
    ledger.writeRecord(recordRow('b'))
    expect(ledger.stats()).toEqual({ unsynced: 3, quarantined: 0, oldestUnsyncedAt: oldest })
    const batch = ledger.pending(10)
    ledger.settle(batch, { records: new Map([[batch.records[0]?.id ?? 0, 'refused']]), picks: new Map() })
    expect(ledger.stats()).toEqual({ unsynced: 0, quarantined: 1, oldestUnsyncedAt: null })
    expect(ledger.pending(10)).toEqual({ records: [], picks: [] })
  })

  test('prune drops synced rows past 62 days, never unsynced or quarantined ones', () => {
    ledger.writeRecord(recordRow('synced-old'))
    ledger.writePick(pickRow('synced-old'))
    ledger.writeRecord(recordRow('quarantined-old'))
    ledger.writeRecord(recordRow('unsynced-old'))
    const batch = ledger.pending(2)
    ledger.settle(batch, { records: new Map([[batch.records[1]?.id ?? 0, 'bad']]), picks: new Map() })
    clock += 61 * DAY
    ledger.writeRecord(recordRow('synced-recent'))
    ledger.settle({ records: ledger.pending(10).records.slice(-1), picks: [] }, none())
    expect(ledger.prune()).toBe(0)
    clock += 2 * DAY
    expect(ledger.prune()).toBe(2)
    expect(ledger.stats()).toMatchObject({ unsynced: 1, quarantined: 1 })
    expect(ledger.spentSince('iu', new Date(0))).toBe(3)
  })

  test('a failed write throws and degrades; the next good write clears it', () => {
    ledger.writeRecord(recordRow('dup'))
    expect(ledger.degraded()).toBeNull()
    expect(() => ledger.writeRecord(recordRow('dup'))).toThrow()
    // The probe write succeeds, so a passing failure clears itself on the next /health.
    expect(ledger.degraded()).toBeNull()
  })

  test('a ledger the disk refuses stays degraded', () => {
    const file = join(dir.path, 'readonly.sqlite')
    const seeded = new Ledger(file)
    seeded.close()
    chmodSync(file, 0o400)
    chmodSync(`${file}-wal`, 0o400)
    const readonly = new Ledger(file)
    expect(() => readonly.writeRecord(recordRow('a'))).toThrow()
    expect(readonly.degraded()).not.toBeNull()
    readonly.close()
  })
})

describe('outbox loop', () => {
  const fakeSink = () => {
    const sink: UsageSink & { batches: number[]; failing: boolean; closed: boolean } = {
      batches: [],
      failing: false,
      closed: false,
      async write(batch) {
        await Bun.sleep(0)
        if (sink.failing) throw new Error('connect ECONNREFUSED')
        sink.batches.push(batch.records.length + batch.picks.length)
        return none()
      },
      close() {
        sink.closed = true
        return Promise.resolve()
      },
    }
    return sink
  }

  test('a batch that fails stays unsynced, the next flush delivers it, and the error clears', async () => {
    const sink = fakeSink()
    const outbox = new Outbox({ ledger, sink, logger: silentLogger() })
    ledger.writeRecord(recordRow('a'))
    sink.failing = true
    await outbox.flush()
    expect(outbox.lastError()).toContain('ECONNREFUSED')
    expect(ledger.stats().unsynced).toBe(1)
    sink.failing = false
    await outbox.flush()
    expect(outbox.lastError()).toBeNull()
    expect(ledger.stats().unsynced).toBe(0)
    expect(sink.batches).toEqual([1])
  })

  test('a long backlog drains in batches', async () => {
    const sink = fakeSink()
    const outbox = new Outbox({ ledger, sink, logger: silentLogger(), batchRows: 2 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) ledger.writeRecord(recordRow(id))
    await outbox.flush()
    expect(sink.batches).toEqual([2, 2, 1])
    expect(ledger.stats().unsynced).toBe(0)
  })

  test('start flushes what a previous life left; poke is debounced; a failure silences poke', async () => {
    ledger.writeRecord(recordRow('left-behind'))
    const sink = fakeSink()
    const outbox = new Outbox({ ledger, sink, logger: silentLogger(), debounceMs: 5, intervalMs: 60_000 })
    outbox.start()
    await outbox.flush()
    expect(ledger.stats().unsynced).toBe(0)
    ledger.writeRecord(recordRow('b'))
    ledger.writeRecord(recordRow('c'))
    outbox.poke()
    outbox.poke()
    await Bun.sleep(30)
    expect(sink.batches).toEqual([1, 2])
    sink.failing = true
    ledger.writeRecord(recordRow('d'))
    outbox.poke()
    await Bun.sleep(30)
    ledger.writeRecord(recordRow('e'))
    let attempts = 0
    sink.write = () => {
      attempts++
      return Promise.reject(new Error('down'))
    }
    outbox.poke()
    await Bun.sleep(30)
    expect(attempts).toBe(0)
    await outbox.close()
    expect(sink.closed).toBe(true)
  })

  test('a flush joined mid-flight is followed by one more, so a late row goes out', async () => {
    const sink = fakeSink()
    const outbox = new Outbox({ ledger, sink, logger: silentLogger() })
    ledger.writeRecord(recordRow('a'))
    const first = outbox.flush()
    ledger.writeRecord(recordRow('late'))
    await outbox.flush()
    await first
    expect(ledger.stats().unsynced).toBe(0)
  })
})
