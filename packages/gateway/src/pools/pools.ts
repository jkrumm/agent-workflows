import { cycleOf } from './cycle.ts'
import type { RegistryPool } from './registry.ts'

/** USD the gateway itself recorded for a pool since an instant (the server's ledger implements it). */
export interface MeterSource {
  spentSince(pool: string, since: Date): number
}

export type PickReason = 'bound' | 'soonest-expiry' | 'claude-code' | 'no-pool' | 'drained-retry'

export type Pick =
  /** `cycleStart` (ISO) is handed back to `drained` / `reconcile`, so a result from before a rollover is ignored. */
  | { kind: 'pool'; pool: string; reason: 'bound' | 'soonest-expiry'; cycleStart: string }
  /** The IU passthrough (`iu-api`). */
  | { kind: 'iu'; reason: 'claude-code' | 'no-pool' | 'drained-retry' }
  /** The caller sent `x-agw-fallback: none`: the server answers 402 with the balance marker. */
  | { kind: 'refuse'; reason: 'no-pool' | 'claude-code' | 'drained-retry' }

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
  /** `charge` calls ignored for a negative or non-finite amount, since start. */
  unpricedCharges: number
}

export interface Pools {
  pick(input: PickInput): Pick
  /**
   * Records where a request was served; the only writer of bindings. `pool` is a pool id, or null for the IU
   * passthrough (`iu-api`), which clears the session's binding. An unknown pool id is ignored and counted.
   */
  served(caller: string, session: string | null, pool: string | null): void
  /**
   * Adds a served response's cost to the pool's running meter. `rowAt` is when the server wrote the response's ledger
   * row; a row written before the meter's last ledger read is already counted and is not added again. Never throws: a
   * negative or non-finite amount counts in `unpricedCharges`, an unknown pool in `unknownPoolCalls`.
   */
  charge(pool: string, usd: number, rowAt: Date): void
  /**
   * A balance refusal on a non-Claude-Code request: the pool is ineligible until its credit expires (24 h if the expiry
   * is unknown). Ignored when `cycleStart` (from the `Pick`) is not the pool's current cycle.
   */
  drained(pool: string, cycleStart: string): void
  /**
   * Sets the reconciled floor of the pool's meter (Wave 4). Ignored when `cycleStart` is not the pool's current cycle.
   * Throws on a negative or non-finite amount (off the request path).
   */
  reconcile(pool: string, usd: number, cycleStart: string): void
  status(): PoolStatus[]
  /** `served` / `charge` / `drained` / `reconcile` calls ignored for a pool id not in the registry, since start. */
  unknownPoolCalls(): number
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
/** How often expired bindings are swept; a lookup checks expiry itself, so the sweep only bounds memory. */
const SWEEP_INTERVAL_MS = MINUTE_MS
/** How often an unknown (rolling) cycle re-reads its meter from the source, since the window moves. */
const ROLLING_RESYNC_MS = MINUTE_MS
/** How long a drained pool with an unknown expiry stays out. */
const UNKNOWN_CYCLE_DRAIN_MS = 24 * HOUR_MS
/** How long a reconciled floor counts on a pool with an unknown expiry (the server reconciles hourly). */
const UNKNOWN_CYCLE_FLOOR_MS = 2 * HOUR_MS

/**
 * The meter of one pool for the current cycle: `max(base + charges, floor + chargesSinceFloor)`.
 *
 * - `base` is the ledger (`MeterSource`) read at `sourcedAtMs`. A known cycle reads it once at creation and again on
 *   rollover; an unknown cycle (rolling `now − 31 d`) re-reads it at most once a minute, lazily, and `charges` restart
 *   from zero. A charge whose ledger row was written before `sourcedAtMs` is in `base` already and is not added.
 * - `floor` is the last reconciled figure; `reconcile` always replaces it. Charges whose row was written at or after
 *   `floorAtMs` add to it. A known cycle drops the floor on rollover; an unknown cycle drops it 2 h after it was set.
 *
 * Server contract for `reconcile`: reconciled = cost report over the complete UTC days of the cycle + the ledger's
 * spend since the start of today, computed and passed to `reconcile` in the same synchronous tick, so no charge falls
 * between the snapshot and the call.
 */
interface Meter {
  cycleStartMs: number
  base: number
  sourcedAtMs: number
  charges: number
  floor: number | null
  floorAtMs: number
  chargesSinceFloor: number
}

interface PoolState {
  pool: RegistryPool
  usable: boolean
  keyResolved: boolean
  meter: Meter
  drainedUntilMs: number | null
  unpricedCharges: number
}

interface Binding {
  pool: string
  expiresAtMs: number
}

const meterUsd = (meter: Meter): number =>
  Math.max(meter.base + meter.charges, meter.floor === null ? 0 : meter.floor + meter.chargesSinceFloor)

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
  let lastSweepMs = Number.NEGATIVE_INFINITY
  let unknownPoolCalls = 0

  const freshMeter = (pool: RegistryPool, at: Date): Meter => {
    const start = cycleOf(pool.cycleDay, at).start
    return {
      cycleStartMs: start.getTime(),
      base: opts.meter.spentSince(pool.id, start),
      sourcedAtMs: at.getTime(),
      charges: 0,
      floor: null,
      floorAtMs: 0,
      chargesSinceFloor: 0,
    }
  }

  const states = new Map<string, PoolState>()
  const created = now()
  for (const pool of opts.registry) {
    if (states.has(pool.id)) throw new Error(`pools: duplicate pool id "${pool.id}"`)
    const key = opts.keys.get(pool.id)
    const keyResolved = key !== undefined && key !== ''
    states.set(pool.id, {
      pool,
      usable: pool.enabled && keyResolved,
      keyResolved,
      meter: freshMeter(pool, created),
      drainedUntilMs: null,
      unpricedCharges: 0,
    })
  }

  /** The pool's state, or undefined (counted) for an id not in the registry. */
  const lookup = (pool: string): PoolState | undefined => {
    const state = states.get(pool)
    if (state === undefined) unknownPoolCalls++
    return state
  }

  /** Brings a pool's meter and drain mark up to `at`: rollover, rolling re-read, floor and drain expiry. */
  const sync = (state: PoolState, at: Date): { start: Date; end: Date | null } => {
    const cycle = cycleOf(state.pool.cycleDay, at)
    const atMs = at.getTime()
    const meter = state.meter
    if (state.pool.cycleDay !== null) {
      if (cycle.start.getTime() !== meter.cycleStartMs) state.meter = freshMeter(state.pool, at)
    } else {
      if (atMs - meter.sourcedAtMs >= ROLLING_RESYNC_MS) {
        meter.cycleStartMs = cycle.start.getTime()
        meter.base = opts.meter.spentSince(state.pool.id, cycle.start)
        meter.sourcedAtMs = atMs
        meter.charges = 0
      }
      if (meter.floor !== null && atMs - meter.floorAtMs >= UNKNOWN_CYCLE_FLOOR_MS) meter.floor = null
    }
    if (state.drainedUntilMs !== null && atMs >= state.drainedUntilMs) state.drainedUntilMs = null
    return cycle
  }

  /** A known cycle must match the caller's `cycleStart`; an unknown one has no rollover, so any value is current. */
  const isCurrentCycle = (state: PoolState, cycle: { start: Date }, cycleStart: string): boolean =>
    state.pool.cycleDay === null || Date.parse(cycleStart) === cycle.start.getTime()

  const isEligible = (state: PoolState): boolean =>
    state.usable &&
    state.drainedUntilMs === null &&
    meterUsd(state.meter) + state.pool.headroomUsd < state.pool.creditUsd

  const liveBinding = (key: string, atMs: number): Binding | undefined => {
    if (atMs - lastSweepMs >= SWEEP_INTERVAL_MS) {
      for (const [k, binding] of bindings) if (binding.expiresAtMs <= atMs) bindings.delete(k)
      lastSweepMs = atMs
    }
    const binding = bindings.get(key)
    return binding !== undefined && binding.expiresAtMs > atMs ? binding : undefined
  }

  const fallback = (input: PickInput, reason: 'no-pool' | 'drained-retry'): Pick =>
    input.fallbackNone ? { kind: 'refuse', reason } : { kind: 'iu', reason }

  return {
    pick(input) {
      if (input.claudeCodeShaped) {
        return input.fallbackNone ? { kind: 'refuse', reason: 'claude-code' } : { kind: 'iu', reason: 'claude-code' }
      }

      const at = now()
      const exclude = new Set(input.exclude ?? [])
      const candidates: { id: string; start: Date; end: Date | null }[] = []
      for (const state of states.values()) {
        if (!state.usable || exclude.has(state.pool.id)) continue
        const cycle = sync(state, at)
        if (isEligible(state)) candidates.push({ id: state.pool.id, ...cycle })
      }

      const bound =
        input.session === null ? undefined : liveBinding(bindingKey(input.caller, input.session), at.getTime())
      const boundCandidate = bound === undefined ? undefined : candidates.find(({ id }) => id === bound.pool)
      if (boundCandidate !== undefined) {
        return {
          kind: 'pool',
          pool: boundCandidate.id,
          reason: 'bound',
          cycleStart: boundCandidate.start.toISOString(),
        }
      }

      // Soonest expiry first, unknown expiries last; Array.prototype.sort is stable, so ties keep registry order.
      const [first] = candidates.toSorted((a, b) => (a.end?.getTime() ?? Infinity) - (b.end?.getTime() ?? Infinity))
      if (first !== undefined) {
        return { kind: 'pool', pool: first.id, reason: 'soonest-expiry', cycleStart: first.start.toISOString() }
      }

      return fallback(input, exclude.size > 0 ? 'drained-retry' : 'no-pool')
    },

    served(caller, session, pool) {
      if (pool !== null && lookup(pool) === undefined) return
      if (session === null) return
      const atMs = now().getTime()
      const key = bindingKey(caller, session)
      liveBinding(key, atMs)
      // The IU passthrough never pins a session: its next request takes credit as soon as a pool is eligible.
      if (pool === null) {
        bindings.delete(key)
        return
      }
      bindings.set(key, { pool, expiresAtMs: atMs + ttlMs })
    },

    charge(pool, usd, rowAt) {
      const state = lookup(pool)
      if (state === undefined) return
      if (!Number.isFinite(usd) || usd < 0) {
        state.unpricedCharges++
        return
      }
      sync(state, now())
      const meter = state.meter
      const rowMs = rowAt.getTime()
      if (rowMs >= meter.sourcedAtMs) meter.charges += usd
      if (meter.floor !== null && rowMs >= meter.floorAtMs) meter.chargesSinceFloor += usd
    },

    drained(pool, cycleStart) {
      const state = lookup(pool)
      if (state === undefined) return
      const at = now()
      const cycle = sync(state, at)
      if (!isCurrentCycle(state, cycle, cycleStart)) return
      state.drainedUntilMs = cycle.end === null ? at.getTime() + UNKNOWN_CYCLE_DRAIN_MS : cycle.end.getTime()
    },

    reconcile(pool, usd, cycleStart) {
      if (!Number.isFinite(usd) || usd < 0) throw new RangeError('pools: reconcile needs a finite USD amount ≥ 0')
      const state = lookup(pool)
      if (state === undefined) return
      const at = now()
      const cycle = sync(state, at)
      if (!isCurrentCycle(state, cycle, cycleStart)) return
      state.meter.floor = usd
      state.meter.floorAtMs = at.getTime()
      state.meter.chargesSinceFloor = 0
    },

    status() {
      const at = now()
      return [...states.values()].map((state) => {
        // Unusable pools are never synced; their cycle is computed for display only.
        const cycle = state.usable ? sync(state, at) : cycleOf(state.pool.cycleDay, at)
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
          unpricedCharges: state.unpricedCharges,
        }
      })
    },

    unknownPoolCalls: () => unknownPoolCalls,
  }
}
