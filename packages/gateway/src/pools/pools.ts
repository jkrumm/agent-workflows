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
  /** The last ledger read failed (message); the pool is ineligible until a read succeeds. */
  meterError?: string
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
   * negative or non-finite amount counts in `unpricedCharges`, an unknown pool in `unknownPoolCalls`; an invalid
   * `rowAt` counts as now; a failing ledger read sets the pool's `meterError` instead of throwing.
   */
  charge(pool: string, usd: number, rowAt: Date): void
  /**
   * A balance refusal on a non-Claude-Code request: the pool is ineligible until its credit expires (24 h if the expiry
   * is unknown). Ignored when `cycleStart` (from the `Pick`) is not the pool's current cycle.
   */
  drained(pool: string, cycleStart: string): void
  /**
   * Sets the reconciled floor of the pool's meter (Wave 4). Ignored when `cycleStart` is not the pool's current cycle.
   * On a known cycle the floor only ever rises: an `usd` not above the current effective floor (floor + charges since)
   * is ignored, since the cost report lags and a dip must never lower the meter. On an unknown (rolling) cycle it
   * replaces the floor, lower allowed. Throws on a negative or non-finite amount (off the request path).
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
/** How often a failed ledger read is retried. */
const LEDGER_RETRY_MS = MINUTE_MS

/**
 * The meter of one pool for the current cycle: `max(base + charges, floor + chargesSinceFloor)`.
 *
 * - `base` is the ledger (`MeterSource`) read at `sourcedAtMs`. A known cycle reads it once at creation and again on
 *   rollover; an unknown cycle (rolling `now − 31 d`) re-reads it at most once a minute, lazily, and `charges` restart
 *   from zero. A charge whose ledger row was written before `sourcedAtMs` is in `base` already and is not added.
 * - `floor` is the last reconciled figure. On a known cycle `reconcile` only raises it; on an unknown cycle it replaces
 *   it. Charges whose row was written at or after `floorAtMs` add to it. A known cycle drops the floor on rollover; an
 *   unknown cycle keeps it until a reconcile replaces it (a stale floor over-counts, the safe side).
 * - A failed ledger read leaves the meter untouched and sets the pool's `meterError` (ineligible); the read is retried
 *   at most once a minute and a success clears it.
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
  meterError: string | null
  lastReadAttemptMs: number
}

interface Binding {
  pool: string
  expiresAtMs: number
}

const meterUsd = (meter: Meter): number =>
  Math.max(meter.base + meter.charges, meter.floor === null ? 0 : meter.floor + meter.chargesSinceFloor)

function compareExpiry(a: Date | null, b: Date | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return a.getTime() - b.getTime()
}

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

  const emptyMeter = (startMs: number, base: number, atMs: number): Meter => ({
    cycleStartMs: startMs,
    base,
    sourcedAtMs: atMs,
    charges: 0,
    floor: null,
    floorAtMs: 0,
    chargesSinceFloor: 0,
  })

  /** A ledger read that never throws. */
  const readLedger = (pool: string, since: Date): { usd: number } | { error: string } => {
    try {
      const usd = opts.meter.spentSince(pool, since)
      return Number.isFinite(usd) ? { usd } : { error: 'ledger returned a non-finite amount' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const states = new Map<string, PoolState>()
  const created = now()
  for (const pool of opts.registry) {
    if (states.has(pool.id)) throw new Error(`pools: duplicate pool id "${pool.id}"`)
    const key = opts.keys.get(pool.id)
    const keyResolved = key !== undefined && key !== ''
    const usable = pool.enabled && keyResolved
    const start = cycleOf(pool.cycleDay, created).start
    // Unusable pools are never synced and never read: a zero meter.
    const read = usable ? readLedger(pool.id, start) : { usd: 0 }
    states.set(pool.id, {
      pool,
      usable,
      keyResolved,
      meter: emptyMeter(start.getTime(), 'usd' in read ? read.usd : 0, created.getTime()),
      drainedUntilMs: null,
      unpricedCharges: 0,
      meterError: 'error' in read ? read.error : null,
      lastReadAttemptMs: created.getTime(),
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
    const rolledOver = state.pool.cycleDay !== null && cycle.start.getTime() !== meter.cycleStartMs
    const rollingStale = state.pool.cycleDay === null && atMs - meter.sourcedAtMs >= ROLLING_RESYNC_MS
    const retrying = state.meterError !== null
    const due = retrying ? atMs - state.lastReadAttemptMs >= LEDGER_RETRY_MS : rolledOver || rollingStale
    if (due) {
      state.lastReadAttemptMs = atMs
      const read = readLedger(state.pool.id, cycle.start)
      if ('error' in read) {
        state.meterError = read.error
      } else {
        state.meterError = null
        if (rolledOver) {
          state.meter = emptyMeter(cycle.start.getTime(), read.usd, atMs)
        } else {
          meter.cycleStartMs = cycle.start.getTime()
          meter.base = read.usd
          meter.sourcedAtMs = atMs
          meter.charges = 0
        }
      }
    }
    if (state.drainedUntilMs !== null && atMs >= state.drainedUntilMs) state.drainedUntilMs = null
    return cycle
  }

  /** A known cycle must match the caller's `cycleStart`; an unknown one has no rollover, so any value is current. */
  const isCurrentCycle = (state: PoolState, cycle: { start: Date }, cycleStart: string): boolean =>
    state.pool.cycleDay === null || Date.parse(cycleStart) === cycle.start.getTime()

  const isEligible = (state: PoolState): boolean =>
    state.usable &&
    state.meterError === null &&
    state.drainedUntilMs === null &&
    meterUsd(state.meter) + state.pool.headroomUsd < state.pool.creditUsd

  const sweep = (atMs: number): void => {
    if (atMs - lastSweepMs < SWEEP_INTERVAL_MS) return
    for (const [k, binding] of bindings) if (binding.expiresAtMs <= atMs) bindings.delete(k)
    lastSweepMs = atMs
  }

  const liveBinding = (key: string, atMs: number): Binding | undefined => {
    const binding = bindings.get(key)
    return binding !== undefined && binding.expiresAtMs > atMs ? binding : undefined
  }

  const fallback = (input: PickInput, reason: 'no-pool' | 'claude-code' | 'drained-retry'): Pick =>
    input.fallbackNone ? { kind: 'refuse', reason } : { kind: 'iu', reason }

  return {
    pick(input) {
      if (input.claudeCodeShaped) return fallback(input, 'claude-code')

      const at = now()
      sweep(at.getTime())
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
      const [first] = candidates.toSorted((a, b) => compareExpiry(a.end, b.end))
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
      sweep(atMs)
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
      const at = now()
      sync(state, at)
      const meter = state.meter
      const rawRowMs = rowAt.getTime()
      const rowMs = Number.isFinite(rawRowMs) ? rawRowMs : at.getTime()
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
      const current = state.meter.floor === null ? 0 : state.meter.floor + state.meter.chargesSinceFloor
      if (state.pool.cycleDay !== null && usd <= current) return
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
          meterUsd: state.usable ? meterUsd(state.meter) : 0,
          drainedUntil: state.drainedUntilMs === null ? null : new Date(state.drainedUntilMs).toISOString(),
          eligible: isEligible(state),
          unpricedCharges: state.unpricedCharges,
          ...(state.meterError === null ? {} : { meterError: state.meterError }),
        }
      })
    },

    unknownPoolCalls: () => unknownPoolCalls,
  }
}
