import { describe, expect, test } from 'bun:test'

import { createPools } from './pools.ts'
import type { MeterSource, PickInput, Pools } from './pools.ts'
import type { RegistryPool } from './registry.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A ledger of `{ pool, at, usd }` rows; counts its reads per pool. */
function fakeLedger(rows: { pool: string; at: string; usd: number }[] = []) {
  const ledger = {
    rows,
    reads: new Map<string, number>(),
    readsOf: (pool: string) => ledger.reads.get(pool) ?? 0,
    spentSince(pool: string, since: Date) {
      ledger.reads.set(pool, ledger.readsOf(pool) + 1)
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

/** A pick as `<pool>:<reason>`, `iu-api:<reason>` or `refuse:<reason>`. */
function picked(pools: Pools, input: Partial<PickInput> = {}): string {
  const pick = pools.pick(req(input))
  if (pick.kind === 'pool') return `${pick.pool}:${pick.reason}`
  return `${pick.kind === 'iu' ? 'iu-api' : 'refuse'}:${pick.reason}`
}

const meterOf = (pools: Pools, id: string) => pools.status().find((s) => s.id === id)?.meterUsd

describe('order for a new session', () => {
  test('the real registry on 2026-11-01: iu (credit expires 11-21) before me (expires 11-27); me2 is disabled', () => {
    const { pools } = setup(
      [
        pool('iu', { creditUsd: 200, cycleDay: 21 }),
        pool('me', { creditUsd: 100, cycleDay: 27 }),
        pool('me2', { creditUsd: 100, cycleDay: null, enabled: false }),
      ],
      { at: '2026-11-01T09:00:00Z' },
    )
    expect(pools.pick(req())).toEqual({
      kind: 'pool',
      pool: 'iu',
      reason: 'soonest-expiry',
      cycleStart: '2026-10-21T00:00:00.000Z',
    })
    expect(pools.pick(req({ exclude: ['iu'] }))).toEqual({
      kind: 'pool',
      pool: 'me',
      reason: 'soonest-expiry',
      cycleStart: '2026-10-27T00:00:00.000Z',
    })
    expect(pools.pick(req({ exclude: ['iu', 'me'] }))).toEqual({ kind: 'iu', reason: 'drained-retry' })
    expect(pools.status().map(({ id, cycleStart, cycleEnd }) => ({ id, cycleStart, cycleEnd }))).toEqual([
      { id: 'iu', cycleStart: '2026-10-21T00:00:00.000Z', cycleEnd: '2026-11-21T00:00:00.000Z' },
      { id: 'me', cycleStart: '2026-10-27T00:00:00.000Z', cycleEnd: '2026-11-27T00:00:00.000Z' },
      { id: 'me2', cycleStart: '2026-10-01T09:00:00.000Z', cycleEnd: null },
    ])
  })

  test('soonest expiry first, unknown expiries after known ones, ties by registry order', () => {
    // At 2026-11-10 the credits expire: day 12 on 11-12, day 14 on 11-14, day 21 on 11-21.
    const registry = [
      pool('unknown-a'),
      pool('d21', { cycleDay: 21 }),
      pool('unknown-b'),
      pool('d14', { cycleDay: 14 }),
      pool('d12', { cycleDay: 12 }),
    ]
    const { pools } = setup(registry)
    const order: string[] = []
    for (;;) {
      const pick = pools.pick(req({ exclude: [...order] }))
      if (pick.kind !== 'pool') break
      expect(pick.reason).toBe('soonest-expiry')
      order.push(pick.pool)
    }
    expect(order).toEqual(['d12', 'd14', 'd21', 'unknown-a', 'unknown-b'])
  })

  test('two pools expiring on the same instant keep registry order', () => {
    const { pools } = setup([pool('b', { cycleDay: 14 }), pool('a', { cycleDay: 14 })])
    expect(picked(pools)).toBe('b:soonest-expiry')
  })

  test('disabled and unresolved pools are skipped and never read from the ledger', () => {
    const { pools, ledger, clock } = setup([pool('off', { enabled: false }), pool('nokey'), pool('ok')], {
      keys: { nokey: undefined },
    })
    expect(picked(pools)).toBe('ok:soonest-expiry')
    clock.advance(5 * MINUTE)
    pools.pick(req())
    pools.status()
    expect(ledger.readsOf('off')).toBe(0)
    expect(ledger.readsOf('nokey')).toBe(0)
    expect(ledger.readsOf('ok')).toBe(2)
  })
})

describe('eligibility and the meter', () => {
  test('meter + headroom == credit is not eligible; just below is', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 97.5 }])
    const { pools, clock } = setup([pool('a')], { ledger })
    expect(picked(pools)).toBe('a:soonest-expiry')
    pools.charge('a', 0.5, clock.now()) // 98 + 2 == 100
    expect(picked(pools)).toBe('iu-api:no-pool')
    expect(pools.status()[0]?.eligible).toBe(false)
  })

  test('the meter starts at the ledger since the cycle start and then runs on charges', () => {
    const ledger = fakeLedger([
      { pool: 'a', at: '2026-10-20T00:00:00Z', usd: 50 }, // previous cycle (expiry day 21)
      { pool: 'a', at: '2026-10-22T00:00:00Z', usd: 10 },
      { pool: 'b', at: '2026-10-22T00:00:00Z', usd: 7 },
    ])
    const { pools, clock } = setup([pool('a', { cycleDay: 21 })], { ledger })
    clock.advance(1000)
    ledger.rows.push({ pool: 'a', at: clock.now().toISOString(), usd: 1.25 })
    pools.charge('a', 1.25, clock.now())
    expect(meterOf(pools, 'a')).toBe(11.25)
    expect(ledger.readsOf('a')).toBe(1)
  })

  test('a known cycle rolls over: the meter restarts from the ledger and a drain mark lapses', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 99 }])
    const { pools, clock } = setup([pool('a', { cycleDay: 14 })], { ledger, at: '2026-11-13T23:30:00Z' })
    pools.drained('a', '2026-10-14T00:00:00.000Z')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-14T00:00:00.000Z')
    clock.set('2026-11-14T00:00:00Z')
    const [status] = pools.status()
    expect(status?.meterUsd).toBe(0)
    expect(status?.drainedUntil).toBeNull()
    expect(status?.eligible).toBe(true)
  })

  test('rollover: a charge whose row the rollover read already counted is not added again', () => {
    const ledger = fakeLedger()
    const { pools, clock } = setup([pool('a', { cycleDay: 14 })], { ledger, at: '2026-11-13T23:59:00Z' })
    // The server writes the row just after the rollover, the rollover read happens, then its charge arrives.
    ledger.rows.push({ pool: 'a', at: '2026-11-14T00:00:01Z', usd: 3 })
    clock.set('2026-11-14T00:00:05Z')
    expect(meterOf(pools, 'a')).toBe(3)
    pools.charge('a', 3, new Date('2026-11-14T00:00:01Z'))
    expect(meterOf(pools, 'a')).toBe(3)
    // A charge from the previous cycle arriving late is not added either.
    pools.charge('a', 4, new Date('2026-11-13T23:59:59Z'))
    expect(meterOf(pools, 'a')).toBe(3)
    pools.charge('a', 2, new Date('2026-11-14T00:00:06Z'))
    expect(meterOf(pools, 'a')).toBe(5)
  })

  test('an unknown cycle re-reads the ledger at most once a minute, charges count in between', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-10-11T00:00:00Z', usd: 20 }])
    const { pools, clock } = setup([pool('a')], { ledger })
    expect(meterOf(pools, 'a')).toBe(20)

    ledger.rows.push({ pool: 'a', at: clock.now().toISOString(), usd: 3 })
    pools.charge('a', 3, clock.now())
    clock.advance(59_000)
    expect(meterOf(pools, 'a')).toBe(23)
    expect(ledger.readsOf('a')).toBe(1)

    clock.advance(1_000)
    expect(meterOf(pools, 'a')).toBe(23)
    expect(ledger.readsOf('a')).toBe(2)

    // The 10-11 00:00 row is inside the window through 11-11 00:00 and out a moment later.
    clock.set('2026-11-11T00:00:00Z')
    expect(meterOf(pools, 'a')).toBe(23)
    clock.advance(MINUTE)
    expect(meterOf(pools, 'a')).toBe(3)
  })

  test('rolling re-read: a charge whose row the re-read already counted is not added again', () => {
    const ledger = fakeLedger()
    const { pools, clock } = setup([pool('a')], { ledger })
    clock.advance(MINUTE)
    const rowAt = clock.now()
    ledger.rows.push({ pool: 'a', at: rowAt.toISOString(), usd: 4 })
    clock.advance(1)
    expect(meterOf(pools, 'a')).toBe(4) // the re-read counted the row
    pools.charge('a', 4, rowAt) // its charge arrives after the re-read
    expect(meterOf(pools, 'a')).toBe(4)
    pools.charge('a', 1, clock.now())
    expect(meterOf(pools, 'a')).toBe(5)
  })

  test('the pool id iu is an ordinary pool', () => {
    const { pools } = setup([pool('iu', { cycleDay: 21 }), pool('me', { cycleDay: 12 })])
    pools.served('agw', 's1', 'iu')
    expect(picked(pools)).toBe('iu:bound')
  })

  test('duplicate pool ids throw', () => {
    expect(() => setup([pool('a'), pool('a')])).toThrow(/duplicate pool id "a"/)
  })
})

describe('reconcile', () => {
  test('on a known cycle only a higher floor is accepted; the meter stays max(base + charges, floor + charges since)', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 1 })], {
      ledger: fakeLedger([{ pool: 'a', at: '2026-11-02T00:00:00Z', usd: 30 }]),
    })
    const cycle = '2026-11-01T00:00:00.000Z'
    pools.reconcile('a', 40, cycle)
    expect(meterOf(pools, 'a')).toBe(40)
    clock.advance(1000)
    pools.charge('a', 5, clock.now())
    expect(meterOf(pools, 'a')).toBe(45)
    pools.reconcile('a', 45, cycle)
    pools.reconcile('a', 38, cycle)
    pools.reconcile('a', 20, cycle)
    expect(meterOf(pools, 'a')).toBe(45)
    pools.reconcile('a', 46, cycle)
    expect(meterOf(pools, 'a')).toBe(46)
  })

  test('a charge whose row is older than the reconcile is in the floor already', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 1 })])
    const before = clock.now()
    clock.advance(1000)
    pools.reconcile('a', 50, '2026-11-01T00:00:00.000Z')
    pools.charge('a', 2, before)
    expect(meterOf(pools, 'a')).toBe(50)
    pools.charge('a', 2, clock.now())
    expect(meterOf(pools, 'a')).toBe(52)
  })

  test('on an unknown cycle the floor never expires by time and a lower reconcile replaces it', () => {
    const { pools, clock } = setup([pool('a')], {
      ledger: fakeLedger([{ pool: 'a', at: '2026-11-01T00:00:00Z', usd: 10 }]),
    })
    pools.reconcile('a', 99, 'any')
    expect(picked(pools)).toBe('iu-api:no-pool')
    clock.advance(30 * HOUR)
    expect(meterOf(pools, 'a')).toBe(99)
    pools.reconcile('a', 20, 'any')
    expect(meterOf(pools, 'a')).toBe(20)
  })

  test('a negative or non-finite amount throws', () => {
    const { pools } = setup([pool('a')])
    expect(() => pools.reconcile('a', -1, 'any')).toThrow(RangeError)
    expect(() => pools.reconcile('a', Number.NaN, 'any')).toThrow(RangeError)
  })
})

describe('stale results across a rollover', () => {
  test('drained and reconcile with the previous cycleStart are ignored; the current one applies', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 14 })], { at: '2026-11-13T23:59:00Z' })
    const pick = pools.pick(req())
    expect(pick).toMatchObject({ kind: 'pool', cycleStart: '2026-10-14T00:00:00.000Z' })
    const stale = pick.kind === 'pool' ? pick.cycleStart : ''

    clock.set('2026-11-14T00:00:01Z')
    pools.drained('a', stale)
    pools.reconcile('a', 99, stale)
    expect(pools.status()[0]).toMatchObject({ drainedUntil: null, meterUsd: 0, eligible: true })

    const current = pools.pick(req())
    expect(current).toMatchObject({ kind: 'pool', cycleStart: '2026-11-14T00:00:00.000Z' })
    pools.drained('a', current.kind === 'pool' ? current.cycleStart : '')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-14T01:00:01.000Z')
  })

  test('an unknown cycle has no rollover: any cycleStart applies', () => {
    const { pools } = setup([pool('a')])
    pools.drained('a', '1970-01-01T00:00:00.000Z')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-10T13:00:00.000Z')
  })
})

describe('never throws on the request path', () => {
  test('a negative or non-finite charge is ignored and counted', () => {
    const { pools, clock } = setup([pool('a')])
    pools.charge('a', -1, clock.now())
    pools.charge('a', Number.NaN, clock.now())
    pools.charge('a', Number.POSITIVE_INFINITY, clock.now())
    expect(pools.status()[0]).toMatchObject({ meterUsd: 0, unpricedCharges: 3 })
  })

  test('an unknown pool id is ignored and counted, also with a null session', () => {
    const { pools, clock } = setup([pool('a')])
    pools.served('agw', 's1', 'nope')
    pools.served('agw', null, 'nope')
    pools.charge('nope', 1, clock.now())
    pools.drained('nope', 'any')
    pools.reconcile('nope', 1, 'any')
    expect(pools.unknownPoolCalls()).toBe(5)
    expect(picked(pools)).toBe('a:soonest-expiry')
  })
})

describe('session binding', () => {
  test('a bound session stays on its pool even when another expires sooner', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    expect(picked(pools)).toBe('late:bound')
    expect(picked(pools, { session: 's2' })).toBe('soon:soonest-expiry')
  })

  test('picking alone never binds', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.pick(req())
    pools.served('agw', 's1', 'late')
    pools.pick(req({ exclude: ['late'] }))
    expect(picked(pools)).toBe('late:bound')
  })

  test('a binding expires after the TTL; each served refreshes it', () => {
    const { pools, clock } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    clock.advance(50 * MINUTE)
    pools.served('agw', 's1', 'late')
    clock.advance(50 * MINUTE)
    expect(picked(pools)).toBe('late:bound')
    clock.advance(10 * MINUTE)
    expect(picked(pools)).toBe('soon:soonest-expiry')
  })

  test('an expired binding is not used before the next sweep', () => {
    const clock = fakeClock('2026-11-10T12:00:00Z')
    const pools = createPools({
      registry: [pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })],
      keys: new Map([
        ['late', 'k'],
        ['soon', 'k'],
      ]),
      meter: fakeLedger(),
      now: clock.now,
      bindingTtlMs: 10_000,
    })
    pools.served('agw', 's1', 'late') // sweeps at t0
    clock.advance(10_000) // expired; the next sweep is 50 s away
    expect(picked(pools)).toBe('soon:soonest-expiry')
  })

  test('the bound pool drains: the request retries elsewhere and served rebinds', () => {
    const { pools } = setup([pool('late', { cycleDay: 21 }), pool('soon', { cycleDay: 12 })])
    pools.served('agw', 's1', 'late')
    pools.drained('late', '2026-10-21T00:00:00.000Z')
    expect(picked(pools, { exclude: ['late'] })).toBe('soon:soonest-expiry')
    pools.served('agw', 's1', 'soon')
    expect(picked(pools)).toBe('soon:bound')
  })

  test('a bound pool in exclude is re-picked even while still eligible', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    expect(picked(pools, { exclude: ['a'] })).toBe('b:soonest-expiry')
  })

  test('a bound pool that runs out of credit is left', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    pools.charge('a', 98, clock.now())
    expect(picked(pools)).toBe('b:soonest-expiry')
  })

  test('serving through the IU passthrough (null) clears the binding', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    pools.served('agw', 's1', null)
    expect(picked(pools)).toBe('b:soonest-expiry')
    expect(pools.unknownPoolCalls()).toBe(0)
  })

  test('the same session id under two callers binds independently', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', 's1', 'a')
    expect(picked(pools, { caller: 'agw' })).toBe('a:bound')
    expect(picked(pools, { caller: 'hermes' })).toBe('b:soonest-expiry')
    pools.served('hermes', 's1', 'b')
    expect(picked(pools, { caller: 'agw' })).toBe('a:bound')
    expect(picked(pools, { caller: 'hermes' })).toBe('b:bound')
  })

  test('a null session never binds', () => {
    const { pools } = setup([pool('a', { cycleDay: 21 }), pool('b', { cycleDay: 12 })])
    pools.served('agw', null, 'a')
    expect(picked(pools, { session: null })).toBe('b:soonest-expiry')
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
  test('no eligible pool goes to the IU passthrough, or refuses no-pool with fallbackNone', () => {
    const { pools } = setup([pool('a', { enabled: false })])
    expect(pools.pick(req())).toEqual({ kind: 'iu', reason: 'no-pool' })
    expect(pools.pick(req({ fallbackNone: true }))).toEqual({ kind: 'refuse', reason: 'no-pool' })
    expect(picked(setup([]).pools)).toBe('iu-api:no-pool')
  })

  test('a retry with nothing left is drained-retry to the IU passthrough, or refused drained-retry', () => {
    const { pools } = setup([pool('a')])
    pools.drained('a', 'any')
    expect(pools.pick(req({ exclude: ['a'] }))).toEqual({ kind: 'iu', reason: 'drained-retry' })
    expect(pools.pick(req({ exclude: ['a'], fallbackNone: true }))).toEqual({ kind: 'refuse', reason: 'drained-retry' })
  })

  test('drained on a known cycle lasts 1 h: a funded pool a stray refusal hit is back soon', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 21 })])
    pools.drained('a', '2026-10-21T00:00:00.000Z')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-10T13:00:00.000Z')
    clock.advance(HOUR - 1)
    expect(picked(pools)).toBe('iu-api:no-pool')
    clock.advance(1)
    expect(picked(pools)).toBe('a:soonest-expiry')
  })

  test('a drain mark never outlives the cycle', () => {
    const { pools, clock } = setup([pool('a', { cycleDay: 21 })], { at: '2026-11-20T23:30:00Z' })
    pools.drained('a', '2026-10-21T00:00:00.000Z')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-21T00:00:00.000Z')
    clock.set('2026-11-21T00:00:00Z')
    expect(picked(pools)).toBe('a:soonest-expiry')
  })

  test('drained on an unknown cycle lasts 1 h too', () => {
    const { pools, clock } = setup([pool('a')])
    pools.drained('a', 'any')
    expect(pools.status()[0]?.drainedUntil).toBe('2026-11-10T13:00:00.000Z')
    clock.advance(HOUR - 1)
    expect(picked(pools)).toBe('iu-api:no-pool')
    clock.advance(1)
    expect(picked(pools)).toBe('a:soonest-expiry')
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
        unpricedCharges: 0,
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
        unpricedCharges: 0,
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
        unpricedCharges: 0,
      },
    ])
  })
})

describe('ledger failures fail closed', () => {
  function flaky(usd = 5) {
    const src = {
      failing: false,
      reads: 0,
      spentSince(): number {
        src.reads++
        if (src.failing) throw new Error('database is locked')
        return usd
      },
    }
    return src
  }
  const build = (src: MeterSource, registry = [pool('a', { cycleDay: 1 })]) => {
    const clock = fakeClock('2026-11-10T12:00:00Z')
    const keys = new Map(registry.map((p) => [p.id, 'sk']))
    return { clock, pools: createPools({ registry, keys, meter: src, now: clock.now }) }
  }

  test('a first read failing at creation starts ineligible, retries once a minute, and recovers', () => {
    const src = flaky()
    src.failing = true
    const { pools, clock } = build(src)
    expect(pools.status()[0]).toMatchObject({ eligible: false, meterError: 'database is locked' })
    expect(picked(pools)).toBe('iu-api:no-pool')
    expect(src.reads).toBe(1)
    clock.advance(MINUTE - 1)
    pools.status()
    expect(src.reads).toBe(1)
    clock.advance(1)
    pools.status()
    expect(src.reads).toBe(2)
    src.failing = false
    clock.advance(MINUTE)
    expect(pools.status()[0]).toMatchObject({ eligible: true, meterUsd: 5 })
    expect(pools.status()[0]?.meterError).toBeUndefined()
  })

  test('a failing rollover read keeps the old meter, sets meterError, and nothing throws', () => {
    const src = flaky()
    const { pools, clock } = build(src, [pool('a', { cycleDay: 14 })])
    src.failing = true
    clock.set('2026-11-14T00:00:00Z')
    expect(() => {
      pools.pick(req())
      pools.served('agw', 's1', 'a')
      pools.charge('a', 1, clock.now())
      pools.drained('a', '2026-11-14T00:00:00.000Z')
      pools.reconcile('a', 1, '2026-11-14T00:00:00.000Z')
      pools.status()
    }).not.toThrow()
    expect(pools.status()[0]).toMatchObject({ eligible: false, meterError: 'database is locked' })
  })

  test('a failing rolling re-read keeps the meter and makes the pool ineligible until it succeeds', () => {
    const src = flaky()
    const { pools, clock } = build(src, [pool('a')])
    src.failing = true
    clock.advance(MINUTE)
    expect(pools.status()[0]).toMatchObject({ eligible: false, meterUsd: 5, meterError: 'database is locked' })
    src.failing = false
    clock.advance(MINUTE)
    expect(pools.status()[0]).toMatchObject({ eligible: true })
  })
})

describe('unusable pools', () => {
  test('are never read; status shows meterUsd 0', () => {
    const ledger = fakeLedger([{ pool: 'a', at: '2026-11-09T00:00:00Z', usd: 50 }])
    const { pools, clock } = setup([pool('a', { enabled: false }), pool('b')], {
      ledger,
      keys: { b: undefined },
    })
    clock.advance(2 * MINUTE)
    expect(pools.status().map((s) => s.meterUsd)).toEqual([0, 0])
    expect(ledger.readsOf('a')).toBe(0)
    expect(ledger.readsOf('b')).toBe(0)
  })
})

describe('charge with an invalid rowAt', () => {
  test('counts as now', () => {
    const { pools } = setup([pool('a')])
    pools.charge('a', 3, new Date(Number.NaN))
    expect(meterOf(pools, 'a')).toBe(3)
  })
})

describe('soonest-expiry ties', () => {
  test('equal and unknown expiries keep registry order', () => {
    const { pools } = setup([pool('a'), pool('b'), pool('c', { cycleDay: 20 }), pool('d', { cycleDay: 20 })])
    expect(picked(pools)).toBe('c:soonest-expiry')
    expect(picked(pools, { exclude: ['c'] })).toBe('d:soonest-expiry')
    expect(picked(pools, { exclude: ['c', 'd'] })).toBe(
      'a:drained-retry'.replace('a:drained-retry', 'a:soonest-expiry'),
    )
  })
})
