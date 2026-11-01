import { cycleOf } from './cycle.ts'
import type { RegistryPool } from './registry.ts'

/** USD the gateway itself recorded for a pool since an instant (the server's ledger implements it). */
export interface MeterSource {
  spentSince(pool: string, since: Date): number
}

export type PickReason = 'bound' | 'soonest-expiry' | 'claude-code' | 'no-pool' | 'drained-retry'

export type Pick =
  | { kind: 'pool'; pool: string; reason: 'bound' | 'soonest-expiry' }
  | { kind: 'iu'; reason: 'claude-code' | 'no-pool' | 'drained-retry' }
  /** The caller sent `x-agw-fallback: none`: the server answers 402 with the balance marker. */
  | { kind: 'refuse'; reason: 'no-pool' | 'claude-code' }

export interface PickInput {
  /** The door-token caller; bindings are namespaced by it. */
  caller: string
  session: string | null
  claudeCodeShaped: boolean
  fallbackNone: boolean
  /** Pools that already refused this request. */
  exclude?: string[]
}

export interface PoolStatus {
  id: string
  enabled: boolean
  keyResolved: boolean
  disabledReason?: string
  /** ISO instant of the previous credit expiry (00:00 UTC on `cycleDay`); for an unknown expiry, `now − 31 d`. */
  cycleStart: string
  /** ISO instant the current credit expires (the next `cycleDay`); null when the expiry day is unknown. */
  cycleEnd: string | null
  creditUsd: number
  meterUsd: number
  drainedUntil: string | null
  eligible: boolean
}

export interface Pools {
  pick(input: PickInput): Pick
  /** Records where a request was served; the only writer of bindings. `target` is a pool id or `'iu'`. */
  served(caller: string, session: string | null, target: string): void
  /** Adds a served response's cost to the pool's running meter. */
  charge(pool: string, usd: number): void
  /** A balance refusal on a non-Claude-Code request: the pool is ineligible until its cycle ends (24 h if unknown). */
  drained(pool: string): void
  /** Replaces the cycle's meter with a reconciled figure when that is higher. */
  reconcile(pool: string, usd: number): void
  status(): PoolStatus[]
}

export interface PoolsOptions {
  registry: RegistryPool[]
  /** Resolved API keys by pool id; `undefined` = the ref did not resolve. */
  keys: ReadonlyMap<string, string | undefined>
  meter: MeterSource
  now?: () => Date
  bindingTtlMs?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DEFAULT_BINDING_TTL_MS = HOUR_MS
/** How often an unknown (rolling) cycle re-reads its meter from the source, since the window moves. */
const ROLLING_RESYNC_MS = MINUTE_MS
/** How long a drained pool with an unknown cycle stays out. */
const UNKNOWN_CYCLE_DRAIN_MS = 24 * HOUR_MS

/**
 * The meter of one pool for the current cycle: `max(base + charges, reconciled + chargesSinceReconcile)`.
 *
 * - Known cycle: `base` is read from the source once, at creation or when the cycle rolls over; from then on only
 *   `charge` moves it. The source is not re-read per request: the running sum is exact for this process, and a re-read
 *   could double-count a response whose ledger row and charge race.
 * - Unknown cycle: the window is `now − 31 d`, so old spend falls out of it; `base` is re-read from the source at most
 *   once a minute (lazily, on the next call) and `charges` restart from zero. Charges between two re-reads are counted
 *   on top. The server should write the ledger row before calling `charge`: a race then over-counts one response for
 *   at most a minute, never under-counts.
 * - `reconcile` raises a floor that later charges add to; it survives the minute re-reads of an unknown cycle and is
 *   dropped when a known cycle rolls over.
 */
interface Meter {
  cycleStartMs: number
  base: number
  charges: number
  sourcedAtMs: number
  reconciled: number | null
  chargesSinceReconcile: number
}

interface PoolState {
  pool: RegistryPool
  keyResolved: boolean
  meter: Meter
  drainedUntilMs: number | null
}

interface Binding {
  pool: string
  expiresAtMs: number
}

const meterUsd = (meter: Meter): number =>
  Math.max(meter.base + meter.charges, meter.reconciled === null ? 0 : meter.reconciled + meter.chargesSinceReconcile)

const bindingKey = (caller: string, session: string): string => JSON.stringify([caller, session])

function disabledReason(state: PoolState): string | undefined {
  if (!state.pool.enabled) return 'disabled in the registry'
  if (!state.keyResolved) return `api key ref did not resolve: ${state.pool.apiKeyRef}`
  return undefined
}

export function createPools(opts: PoolsOptions): Pools {
  const now = opts.now ?? (() => new Date())
  const ttlMs = opts.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS
  const bindings = new Map<string, Binding>()

  const freshMeter = (pool: RegistryPool, at: Date): Meter => {
    const start = cycleOf(pool.cycleDay, at).start
    return {
      cycleStartMs: start.getTime(),
      base: opts.meter.spentSince(pool.id, start),
      charges: 0,
      sourcedAtMs: at.getTime(),
      reconciled: null,
      chargesSinceReconcile: 0,
    }
  }

  const states = new Map<string, PoolState>()
  const created = now()
  for (const pool of opts.registry) {
    if (states.has(pool.id)) throw new Error(`pools: duplicate pool id "${pool.id}"`)
    const key = opts.keys.get(pool.id)
    states.set(pool.id, {
      pool,
      keyResolved: key !== undefined && key !== '',
      meter: freshMeter(pool, created),
      drainedUntilMs: null,
    })
  }

  const stateOf = (pool: string): PoolState => {
    const state = states.get(pool)
    if (state === undefined) throw new Error(`pools: unknown pool "${pool}"`)
    return state
  }

  /** Brings a pool's meter and drain mark up to `at`: cycle rollover, rolling re-read, drain expiry. */
  const sync = (state: PoolState, at: Date): { start: Date; end: Date | null } => {
    const cycle = cycleOf(state.pool.cycleDay, at)
    const atMs = at.getTime()
    if (state.pool.cycleDay !== null && cycle.start.getTime() !== state.meter.cycleStartMs) {
      state.meter = freshMeter(state.pool, at)
    } else if (state.pool.cycleDay === null && atMs - state.meter.sourcedAtMs >= ROLLING_RESYNC_MS) {
      state.meter.cycleStartMs = cycle.start.getTime()
      state.meter.base = opts.meter.spentSince(state.pool.id, cycle.start)
      state.meter.charges = 0
      state.meter.sourcedAtMs = atMs
    }
    if (state.drainedUntilMs !== null && atMs >= state.drainedUntilMs) state.drainedUntilMs = null
    return cycle
  }

  const isEligible = (state: PoolState): boolean =>
    state.pool.enabled &&
    state.keyResolved &&
    state.drainedUntilMs === null &&
    meterUsd(state.meter) + state.pool.headroomUsd < state.pool.creditUsd

  const sweep = (atMs: number): void => {
    for (const [key, binding] of bindings) if (binding.expiresAtMs <= atMs) bindings.delete(key)
  }

  const fallback = (input: PickInput, reason: 'no-pool' | 'drained-retry'): Pick => {
    if (input.fallbackNone) return { kind: 'refuse', reason: 'no-pool' }
    return { kind: 'iu', reason }
  }

  return {
    pick(input) {
      if (input.claudeCodeShaped) {
        return input.fallbackNone ? { kind: 'refuse', reason: 'claude-code' } : { kind: 'iu', reason: 'claude-code' }
      }

      const at = now()
      sweep(at.getTime())
      const exclude = new Set(input.exclude ?? [])
      const candidates = [...states.values()]
        .map((state) => ({ state, end: sync(state, at).end }))
        .filter(({ state }) => !exclude.has(state.pool.id) && isEligible(state))

      const bound = input.session === null ? undefined : bindings.get(bindingKey(input.caller, input.session))
      if (bound !== undefined && candidates.some(({ state }) => state.pool.id === bound.pool)) {
        return { kind: 'pool', pool: bound.pool, reason: 'bound' }
      }

      // Soonest cycle end first, unknown ends last; Array.prototype.sort is stable, so ties keep registry order.
      const [first] = candidates.toSorted((a, b) => (a.end?.getTime() ?? Infinity) - (b.end?.getTime() ?? Infinity))
      if (first !== undefined) return { kind: 'pool', pool: first.state.pool.id, reason: 'soonest-expiry' }

      return fallback(input, exclude.size > 0 ? 'drained-retry' : 'no-pool')
    },

    served(caller, session, target) {
      const atMs = now().getTime()
      sweep(atMs)
      if (session === null) return
      const key = bindingKey(caller, session)
      // IU never pins a session: its next request takes credit again as soon as a pool is eligible.
      if (target === 'iu') {
        bindings.delete(key)
        return
      }
      stateOf(target)
      bindings.set(key, { pool: target, expiresAtMs: atMs + ttlMs })
    },

    charge(pool, usd) {
      if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`pools: charge must be a finite USD amount ≥ 0`)
      const state = stateOf(pool)
      sync(state, now())
      state.meter.charges += usd
      if (state.meter.reconciled !== null) state.meter.chargesSinceReconcile += usd
    },

    drained(pool) {
      const state = stateOf(pool)
      const at = now()
      const { end } = sync(state, at)
      state.drainedUntilMs = end === null ? at.getTime() + UNKNOWN_CYCLE_DRAIN_MS : end.getTime()
    },

    reconcile(pool, usd) {
      if (!Number.isFinite(usd)) throw new RangeError(`pools: reconcile needs a finite USD amount`)
      const state = stateOf(pool)
      sync(state, now())
      if (usd <= meterUsd(state.meter)) return
      state.meter.reconciled = usd
      state.meter.chargesSinceReconcile = 0
    },

    status() {
      const at = now()
      return [...states.values()].map((state) => {
        const cycle = sync(state, at)
        const reason = disabledReason(state)
        return {
          id: state.pool.id,
          enabled: state.pool.enabled,
          keyResolved: state.keyResolved,
          ...(reason === undefined ? {} : { disabledReason: reason }),
          cycleStart: cycle.start.toISOString(),
          cycleEnd: cycle.end?.toISOString() ?? null,
          creditUsd: state.pool.creditUsd,
          meterUsd: meterUsd(state.meter),
          drainedUntil: state.drainedUntilMs === null ? null : new Date(state.drainedUntilMs).toISOString(),
          eligible: isEligible(state),
        }
      })
    },
  }
}
