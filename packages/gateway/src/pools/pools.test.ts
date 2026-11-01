import { describe, expect, test } from 'bun:test'

import { createPools } from './pools.ts'
import type { MeterSource, PickInput } from './pools.ts'
import type { RegistryPool } from './registry.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A ledger of `{ pool, at, usd }` rows; counts its reads. */
function fakeLedger(rows: { pool: string; at: string; usd: number }[] = []) {
  const ledger = {
    rows,
    reads: 0,
    spentSince(pool: string, since: Date) {
      ledger.reads++
      return ledger.rows
        .filter((row) => row.pool === pool && new Date(row.at).getTime() >= since.getTime())
        .reduce((sum, row) => sum + row.usd, 0)
    },
  }
  return ledger satisfies MeterSource
}

function fakeClock(start: string) {
  let t = new Date(start).getTime()
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
    set: (iso: string) => {
      t = new Date(iso).getTime()
    },
  }
}

const pool = (id: string, over: Partial<RegistryPool> = {}): RegistryPool => ({
  id,
  creditUsd: 100,
  cycleDay: null,
  headroomUsd: 2,
  enabled: true,
  apiKeyRef: `op://vault/item/${id}`,
  ...over,
})

function setup(
  registry: RegistryPool[],
  opts: { ledger?: ReturnType<typeof fakeLedger>; at?: string; keys?: Record<string, string | undefined> } = {},
) {
  const ledger = opts.ledger ?? fakeLedger()
  const clock = fakeClock(opts.at ?? '2026-11-10T12:00:00Z')
  const keys = new Map<string, string | undefined>(
    registry.map((p) => [p.id, opts.keys && p.id in opts.keys ? opts.keys[p.id] : `sk-${p.id}`]),
  )
  const pools = createPools({ registry, keys, meter: ledger, now: clock.now })
  return { pools, ledger, clock }
}

const req = (over: Partial<PickInput> = {}): PickInput => ({
  caller: 'agw',
  session: 's1',
  claudeCodeShaped: false,
  fallbackNone: false,
  ...over,
})

describe('order for a new session', () => {
  test('soonest cycle end first, unknown ends after known ones, ties by registry order', () => {
    // At 2026-11-10: day 14 ends 11-14, day 21 ends 11-21, day 12 ends 11-12.
    const registry = [
      pool('unknown-a'),
      pool('d21', { cycleDay: 21 }),
      pool('unknown-b'),
      pool('d14', { cycleDay: 14 }),
      pool('d12', { cycleDay: 12 }),
    ]
    const { pools } = setup(registry)
    const order: string[] = []
    const exclude: string[] = []
    for (;;) {
      const pick = pools.pick(req({ exclude: [...exclude] }))
      if (pick.kind !== 'pool') break
      expect(pick.reason).toBe('soonest-expiry')
      order.push(pick.pool)
      exclude.push(pick.pool)
    }
    expect(order).toEqual(['d12', 'd14', 'd21', 'unknown-a', 'unknown-b'])
  })

  test('two known pools ending on the same instant keep registry order', () => {
    const { pools } = setup([pool('b', { cycleDay: 14 }), pool('a', { cycleDay: 14 })])
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
  })

  test('disabled and unresolved pools are skipped', () => {
    const { pools } = setup(
      [pool('off', { enabled: false, cycleDay: 11 }), pool('nokey', { cycleDay: 12 }), pool('ok')],
      {
        keys: { nokey: undefined },
      },
    )
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'ok', reason: 'soonest-expiry' })
  })
})

describe('eligibility and the meter', () => {
  test('meter + headroom == credit is not eligible; just below is', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 97.5 }])
    const { pools } = setup([pool('a')], { ledger })
    expect(pools.pick(req()).kind).toBe('pool')
    pools.charge('a', 0.5) // 98 + 2 == 100
    expect(pools.pick(req())).toEqual({ kind: 'iu', reason: 'no-pool' })
    expect(pools.status()[0]?.eligible).toBe(false)
  })

  test('the meter starts at the ledger since the cycle start and then runs on charges', () => {
    const ledger = fakeLedger([
      { pool: 'a', at: '2026-10-20T00:00:00Z', usd: 50 }, // previous cycle (day 21)
      { pool: 'a', at: '2026-10-22T00:00:00Z', usd: 10 },
      { pool: 'b', at: '2026-10-22T00:00:00Z', usd: 7 },
    ])
    const { pools } = setup([pool('a', { cycleDay: 21 })], { ledger })
    expect(ledger.reads).toBe(1)
    pools.charge('a', 1.25)
    ledger.rows.push({ pool: 'a', at: '2026-11-10T12:00:00Z', usd: 1.25 })
    expect(pools.status()[0]?.meterUsd).toBe(11.25)
    expect(ledger.reads).toBe(1)
  })

  test('a known cycle rolls over: the meter restarts from the ledger and a drain mark lapses', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 99 }])
    const { pools, clock } = setup([pool('a', { cycleDay: 14 })], { ledger })
    pools.drained('a')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-14T00:00:00.000Z')
    clock.set('2026-11-14T00:00:00Z')
    const [status] = pools.status()
    expect(status?.meterUsd).toBe(0)
    expect(status?.drainedUntil).toBeNull()
    expect(status?.eligible).toBe(true)
  })

  test('an unknown cycle re-reads the ledger at most once a minute, charges count in between', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-10-11T00:00:00Z', usd: 20 }])
    const { pools, clock } = setup([pool('a')], { ledger })
    expect(pools.status()[0]?.meterUsd).toBe(20)

    pools.charge('a', 3)
    ledger.rows.push({ pool: 'a', at: '2026-11-10T12:00:00Z', usd: 3 })
    clock.advance(59_000)
    expect(pools.status()[0]?.meterUsd).toBe(23)
    expect(ledger.reads).toBe(1)

    clock.advance(1_000)
    expect(pools.status()[0]?.meterUsd).toBe(23)
    expect(ledger.reads).toBe(2)

    // The 10-11 00:00 row is inside the window through 11-11 00:00 and out a moment later.
    clock.set('2026-11-11T00:00:00Z')
    expect(pools.status()[0]?.meterUsd).toBe(23)
    clock.advance(MINUTE)
    expect(pools.status()[0]?.meterUsd).toBe(3)
  })

  test('reconcile replaces the meter only when higher; later charges add to it', () => {
    const { pools } = setup([pool('a', { cycleDay: 1 })], {
      ledger: fakeLedger([{ pool: 'a', at: '2026-11-02T00:00:00Z', usd: 30 }]),
    })
    pools.reconcile('a', 25)
    expect(pools.status()[0]?.meterUsd).toBe(30)
    pools.reconcile('a', 40)
    expect(pools.status()[0]?.meterUsd).toBe(40)
    pools.charge('a', 5)
    expect(pools.status()[0]?.meterUsd).toBe(45)
    pools.reconcile('a', 44)
    expect(pools.status()[0]?.meterUsd).toBe(45)
  })

  test('a reconciled floor survives the minute re-reads of an unknown cycle', () => {
    const { pools, clock } = setup([pool('a')], {
      ledger: fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 10 }]),
    })
    pools.reconcile('a', 60)
    clock.advance(5 * MINUTE)
    expect(pools.status()[0]?.meterUsd).toBe(60)
  })

  test('unknown pools and bad amounts throw', () => {
    const { pools } = setup([pool('a')])
    expect(() => pools.charge('nope', 1)).toThrow(/unknown pool "nope"/)
    expect(() => pools.drained('nope')).toThrow(/unknown pool/)
    expect(() => pools.reconcile('nope', 1)).toThrow(/unknown pool/)
    expect(() => pools.served('agw', 's1', 'nope')).toThrow(/unknown pool/)
    expect(() => pools.charge('a', -1)).toThrow(RangeError)
    expect(() => pools.charge('a', Number.NaN)).toThrow(RangeError)
  })

  test('duplicate pool ids throw', () => {
    expect(() => setup([pool('a'), pool('a')])).toThrow(/duplicate pool id "a"/)
  })
})

describe('session binding', () => {
  test('a bound session stays on its pool even when another ends sooner', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'late', reason: 'bound' })
    expect(pools.pick(req({ session: 's2' }))).toEqual({ kind: 'pool', pool: 'soon', reason: 'soonest-expiry' })
  })

  test('picking alone never binds', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.pick(req())
    pools.served('agw', 's1', 'late')
    pools.pick(req({ exclude: ['late'] }))
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'late', reason: 'bound' })
  })

  test('a binding expires after the TTL; each served refreshes it', () => {
    const { pools, clock } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    clock.advance(50 * MINUTE)
    pools.served('agw', 's1', 'late')
    clock.advance(50 * MINUTE)
    expect(pools.pick(req()).reason).toBe('bound')
    clock.advance(10 * MINUTE)
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'soon', reason: 'soonest-expiry' })
  })

  test('the TTL is configurable', () => {
    const clock = fakeClock('2026-11-10T12:00:00Z')
    const pools = createPools({
      registry: [pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })],
      keys: new Map([
        ['late', 'k'],
        ['soon', 'k'],
      ]),
      meter: fakeLedger(),
      now: clock.now,
      bindingTtlMs: MINUTE,
    })
    pools.served('agw', 's1', 'late')
    clock.advance(MINUTE)
    expect(pools.pick(req()).reason).toBe('soonest-expiry')
  })

  test('the bound pool drains: the request retries elsewhere and served rebinds', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    pools.drained('late')
    const retry = pools.pick(req({ exclude: ['late'] }))
    expect(retry).toEqual({ kind: 'pool', pool: 'soon', reason: 'soonest-expiry' })
    pools.served('agw', 's1', 'soon')
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'soon', reason: 'bound' })
  })

  test('a bound pool in exclude is re-picked even while still eligible', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    expect(pools.pick(req({ exclude: ['a'] }))).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
  })

  test('a bound pool that runs out of credit is left', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    pools.charge('a', 98)
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
  })

  test('serving from IU clears the binding', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    pools.served('agw', 's1', 'iu')
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
  })

  test('the same session id under two callers binds independently', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    expect(pools.pick(req({ caller: 'agw' }))).toEqual({ kind: 'pool', pool: 'a', reason: 'bound' })
    expect(pools.pick(req({ caller: 'hermes' }))).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
    pools.served('hermes', 's1', 'b')
    expect(pools.pick(req({ caller: 'agw' }))).toEqual({ kind: 'pool', pool: 'a', reason: 'bound' })
    expect(pools.pick(req({ caller: 'hermes' }))).toEqual({ kind: 'pool', pool: 'b', reason: 'bound' })
  })

  test('a null session never binds', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', null, 'a')
    expect(pools.pick(req({ session: null }))).toEqual({ kind: 'pool', pool: 'b', reason: 'soonest-expiry' })
  })
})

describe('step 0: Claude-Code-shaped requests', () => {
  test('never a pool, even a bound one', () => {
    const { pools } = setup([pool('a')])
    pools.served('agw', 's1', 'a')
    expect(pools.pick(req({ claudeCodeShaped: true }))).toEqual({ kind: 'iu', reason: 'claude-code' })
  })

  test('refused with fallbackNone', () => {
    const { pools } = setup([pool('a')])
    expect(pools.pick(req({ claudeCodeShaped: true, fallbackNone: true }))).toEqual({
      kind: 'refuse',
      reason: 'claude-code',
    })
  })
})

describe('no pool and drained', () => {
  test('no eligible pool goes to IU, or refuses with fallbackNone', () => {
    const { pools } = setup([pool('a', { enabled: false })])
    expect(pools.pick(req())).toEqual({ kind: 'iu', reason: 'no-pool' })
    expect(pools.pick(req({ fallbackNone: true }))).toEqual({ kind: 'refuse', reason: 'no-pool' })
    expect(setup([]).pools.pick(req())).toEqual({ kind: 'iu', reason: 'no-pool' })
  })

  test('a retry with nothing left is drained-retry to IU, or refuses no-pool with fallbackNone', () => {
    const { pools } = setup([pool('a')])
    pools.drained('a')
    expect(pools.pick(req({ exclude: ['a'] }))).toEqual({ kind: 'iu', reason: 'drained-retry' })
    expect(pools.pick(req({ exclude: ['a'], fallbackNone: true }))).toEqual({ kind: 'refuse', reason: 'no-pool' })
  })

  test('drained on a known cycle lasts until the cycle ends', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 21 })])
    pools.drained('a')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-21T00:00:00.000Z')
    clock.set('2026-11-20T23:59:59Z')
    expect(pools.pick(req())).toEqual({ kind: 'iu', reason: 'no-pool' })
    clock.set('2026-11-21T00:00:00Z')
    expect(pools.pick(req())).toEqual({ kind: 'pool', pool: 'a', reason: 'soonest-expiry' })
  })

  test('drained on an unknown cycle lasts 24 h', () => {
    const { pools, clock } = setup([pool('a')])
    pools.drained('a')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-11T12:00:00.000Z')
    clock.advance(DAY - 1)
    expect(pools.pick(req()).kind).toBe('iu')
    clock.advance(1)
    expect(pools.pick(req()).kind).toBe('pool')
  })
})

describe('status', () => {
  test('one entry per registry pool, in registry order', () => {
    const { pools } = setup(
      [
        pool('iu', { creditUsd: 200, cycleDay: 21 }),
        pool('me', { enabled: false }),
        pool('me2', { apiKeyRef: 'op://vault/item/ME2' }),
      ],
      {
        keys: { me2: undefined },
        ledger: fakeLedger([{ pool: 'iu', at: '2026-11-01T00:00:00Z', usd: 12.5 }]),
      },
    )
    expect(pools.status()).toEqual([
      {
        id: 'iu',
        enabled: true,
        keyResolved: true,
        cycleStart: '2026-10-21T00:00:00.000Z',
        cycleEnd: '2026-11-21T00:00:00.000Z',
        creditUsd: 200,
        meterUsd: 12.5,
        drainedUntil: null,
        eligible: true,
      },
      {
        id: 'me',
        enabled: false,
        keyResolved: true,
        disabledReason: 'disabled in the registry',
        cycleStart: '2026-10-10T12:00:00.000Z',
        cycleEnd: null,
        creditUsd: 100,
        meterUsd: 0,
        drainedUntil: null,
        eligible: false,
      },
      {
        id: 'me2',
        enabled: true,
        keyResolved: false,
        disabledReason: 'api key ref did not resolve: op://vault/item/ME2',
        cycleStart: '2026-10-10T12:00:00.000Z',
        cycleEnd: null,
        creditUsd: 100,
        meterUsd: 0,
        drainedUntil: null,
        eligible: false,
      },
    ])
  })
})
