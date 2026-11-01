import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Ledger } from '../src/ledger.ts'
import { createPools, type RegistryPool } from '../src/pools/index.ts'
import { Reconciler } from '../src/reconcile.ts'
import { fakeUpstream, pool, POOL_KEY, silentLogger, tempDir, type Upstream, recordRow } from './support.ts'

const ADMIN_KEY = 'fake-admin-key'
const NOW = '2026-11-20T15:30:00Z'
const bucket = (...amounts: string[]) => ({ results: amounts.map((amount) => ({ amount, currency: 'USD' })) })
const page = (data: unknown[], next: string | null = null) =>
  Response.json({ data, has_more: next !== null, next_page: next })

let admin: Upstream
let dir: ReturnType<typeof tempDir>
let ledger: Ledger
let clockMs = Date.parse(NOW)

beforeEach(() => {
  admin = fakeUpstream(() => page([]))
  dir = tempDir()
  clockMs = Date.parse(NOW)
  ledger = new Ledger(join(dir.path, 'ledger.sqlite'), { now: () => clockMs })
})

afterEach(() => {
  admin.stop()
  ledger.close()
  dir.remove()
})

function scene(registry: RegistryPool[], adminKeys = new Map(registry.map((p) => [p.id, ADMIN_KEY]))) {
  const now = () => new Date(clockMs)
  const pools = createPools({ registry, keys: new Map(registry.map((p) => [p.id, POOL_KEY])), meter: ledger, now })
  const logger = silentLogger()
  const reconciler = new Reconciler({ registry, adminKeys, pools, ledger, logger, baseUrl: admin.url, now })
  return { pools, logger, reconciler, meter: () => pools.status()[0]?.meterUsd }
}

const query = (index = 0) => new URL(`http://x${admin.seen[index]?.path ?? ''}`).searchParams

describe('reconcile', () => {
  test('cents as decimal strings, every bucket and page, plus the ledger since today', async () => {
    admin.reply((seen) => {
      if (seen.path.includes('page=p2')) return page([bucket('50.5')])
      return page([bucket('1234.567890', '100'), bucket('200')], 'p2')
    })
    ledger.writeRecord(recordRow('today', { cost_reported_usd: 3 }))
    const { reconciler, meter } = scene([pool('iu', { cycleDay: 15 })])
    await reconciler.runAll()
    expect(meter()).toBeCloseTo(15.8506789 + 3, 6)
    expect(admin.seen).toHaveLength(2)
    expect(query(0).get('starting_at')).toBe('2026-11-15T00:00:00Z')
    expect(query(0).get('ending_at')).toBe('2026-11-20T00:00:00Z')
    expect(query(0).get('bucket_width')).toBe('1d')
    expect(query(1).get('page')).toBe('p2')
    expect(admin.seen[0]?.headers.get('x-api-key')).toBe(ADMIN_KEY)
    expect(admin.seen[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  test('the ledger covers the current-day gap only: earlier ledger rows are the report’s', async () => {
    clockMs = Date.parse('2026-11-19T10:00:00Z')
    ledger.writeRecord(recordRow('yesterday', { cost_reported_usd: 7 }))
    clockMs = Date.parse(NOW)
    ledger.writeRecord(recordRow('today', { cost_reported_usd: 2 }))
    admin.reply(() => page([bucket('1000')]))
    const { reconciler, pools } = scene([pool('iu', { cycleDay: 15 })])
    expect(pools.status()[0]?.meterUsd).toBe(9)
    await reconciler.runAll()
    // Reconciled 10 + 2 = 12 beats the ledger's 9.
    expect(pools.status()[0]?.meterUsd).toBe(12)
  })

  test('a charge after the reconcile counts on top; a lower report never lowers the meter', async () => {
    admin.reply(() => page([bucket('2000')]))
    const { reconciler, pools } = scene([pool('iu', { cycleDay: 15 })])
    await reconciler.runAll()
    clockMs += 1000
    const at = ledger.writeRecord(recordRow('after', { cost_reported_usd: 1 }))
    pools.charge('iu', 1, at)
    expect(pools.status()[0]?.meterUsd).toBe(21)
    admin.reply(() => page([bucket('100')]))
    await reconciler.runAll()
    expect(pools.status()[0]?.meterUsd).toBe(21)
  })

  test('a cycle that started today skips the call: the report refuses a start inside the current day', async () => {
    clockMs = Date.parse('2026-11-15T09:00:00Z')
    ledger.writeRecord(recordRow('today', { cost_reported_usd: 4 }))
    const { reconciler, pools } = scene([pool('iu', { cycleDay: 15 })])
    await reconciler.runAll()
    expect(admin.seen).toHaveLength(0)
    expect(pools.status()[0]?.meterUsd).toBe(4)
    expect(reconciler.status('iu').reconciledAt).not.toBeNull()
  })

  test('a null cycle reads the rolling 31 days, whole UTC days', async () => {
    admin.reply(() => page([bucket('500')]))
    const { reconciler, pools } = scene([pool('iu', { cycleDay: null })])
    await reconciler.runAll()
    expect(query().get('starting_at')).toBe('2026-10-20T00:00:00Z')
    expect(query().get('ending_at')).toBe('2026-11-20T00:00:00Z')
    expect(pools.status()[0]?.meterUsd).toBe(5)
  })

  test.each([
    ['a 500', () => new Response('boom', { status: 500 }), 'http-500'],
    ['a 401', () => new Response('no', { status: 401 }), 'http-401'],
    ['a non-JSON body', () => new Response('<html>'), 'malformed'],
    ['an amount that is no number', () => page([bucket('abc')]), 'malformed'],
    ['has_more without a page', () => Response.json({ data: [], has_more: true, next_page: null }), 'malformed'],
  ])('%s keeps the ledger meter and logs the kind once', async (_name, reply, kind) => {
    ledger.writeRecord(recordRow('today', { cost_reported_usd: 2 }))
    admin.reply(reply)
    const { reconciler, pools, logger } = scene([pool('iu', { cycleDay: 15 })])
    await reconciler.runAll()
    await reconciler.runAll()
    expect(pools.status()[0]?.meterUsd).toBe(2)
    expect(reconciler.status('iu')).toEqual({ reconciledAt: null, reconcileError: kind })
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
    expect(JSON.stringify(logger.lines)).not.toContain(ADMIN_KEY)
  })

  test('a network failure keeps the meter; a later success clears the error and keeps its stamp', async () => {
    admin.stop()
    const { reconciler } = scene([pool('iu', { cycleDay: 15 })])
    await reconciler.runAll()
    expect(reconciler.status('iu').reconcileError).toBe('network')
    admin = fakeUpstream(() => page([bucket('100')]))
    const healed = new Reconciler({
      registry: [pool('iu', { cycleDay: 15 })],
      adminKeys: new Map([['iu', ADMIN_KEY]]),
      pools: createPools({ registry: [pool('iu')], keys: new Map([['iu', POOL_KEY]]), meter: ledger }),
      ledger,
      logger: silentLogger(),
      baseUrl: admin.url,
    })
    await healed.runAll()
    expect(healed.status('iu').reconcileError).toBeNull()
    expect(healed.status('iu').reconciledAt).not.toBeNull()
  })

  describe('the stored figure across a restart', () => {
    const iu = pool('iu', { cycleDay: 15 })
    /** One life: a good reconcile at $56.11, then spend the ledger sees. */
    const firstLife = async () => {
      admin.reply(() => page([bucket('5611')]))
      await scene([iu]).reconciler.boot()
      clockMs += 60_000
      ledger.writeRecord(recordRow('after', { cost_reported_usd: 1 }))
      clockMs += 60_000
    }

    test('the live reconcile failing at boot restores it plus the ledger since it', async () => {
      await firstLife()
      admin.reply(() => new Response('down', { status: 503 }))
      const { reconciler, meter, logger } = scene([iu])
      expect(meter()).toBe(1)
      await reconciler.boot()
      expect(meter()).toBeCloseTo(57.11, 6)
      expect(reconciler.status('iu').reconcileError).toBe('http-503')
      expect(logger.lines.some((line) => line.message.includes('restored'))).toBe(true)
    })

    test('no admin key at boot restores it too', async () => {
      await firstLife()
      const { reconciler, meter } = scene([iu], new Map())
      await reconciler.boot()
      expect(meter()).toBeCloseTo(57.11, 6)
      expect(reconciler.status('iu').reconcileError).toBe('admin-key-missing')
    })

    test('a figure of another cycle stays out', async () => {
      await firstLife()
      clockMs = Date.parse('2026-12-16T10:00:00Z')
      admin.reply(() => new Response('down', { status: 503 }))
      const { reconciler, meter } = scene([iu])
      await reconciler.boot()
      expect(meter()).toBe(0)
    })

    test('a live reconcile at boot wins, and writes the new figure', async () => {
      await firstLife()
      admin.reply(() => page([bucket('8000')]))
      const { reconciler, meter } = scene([iu])
      await reconciler.boot()
      // $80 from the report plus today's ledger row.
      expect(meter()).toBe(81)
      expect(ledger.floorOf('iu', '2026-11-15T00:00:00.000Z')?.usd).toBe(81)
    })

    test('an hourly failure never touches the meter: the floor is in memory', async () => {
      admin.reply(() => page([bucket('5611')]))
      const { reconciler, meter } = scene([iu])
      await reconciler.boot()
      admin.reply(() => new Response('down', { status: 503 }))
      await reconciler.runAll()
      expect(meter()).toBeCloseTo(56.11, 6)
    })

    test('an unknown cycle keeps it across restarts, up to the window it covers', async () => {
      const rolling = pool('iu', { cycleDay: null })
      admin.reply(() => page([bucket('1000')]))
      await scene([rolling]).reconciler.boot()
      admin.reply(() => new Response('down', { status: 503 }))
      const again = scene([rolling])
      await again.reconciler.boot()
      expect(again.meter()).toBe(10)
      clockMs += 32 * 86_400_000
      const stale = scene([rolling])
      await stale.reconciler.boot()
      expect(stale.meter()).toBe(0)
    })
  })

  test('no admin key: no call, the status says so, one pool failing leaves the other', async () => {
    admin.reply(() => page([bucket('100')]))
    const registry = [pool('iu', { cycleDay: 15 }), pool('me', { cycleDay: 15 })]
    const { reconciler, pools } = scene(registry, new Map([['me', ADMIN_KEY]]))
    await reconciler.runAll()
    expect(reconciler.status('iu').reconcileError).toBe('admin-key-missing')
    expect(reconciler.status('me').reconcileError).toBeNull()
    expect(pools.status().map((status) => status.meterUsd)).toEqual([0, 1])
    expect(admin.seen).toHaveLength(1)
  })
})
