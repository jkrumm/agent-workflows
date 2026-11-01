import { z } from 'zod'
import type { FloorStore } from './ledger.ts'
import { errorMessage, type Logger } from './log.ts'
import { cycleOf, type MeterSource, type Pools, type RegistryPool } from './pools/index.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** A stored figure of an unknown (rolling) cycle stops being one after the window it covered. */
const ROLLING_WINDOW_MS = 31 * DAY_MS
const ROLLING_KEY = 'rolling'
/** The whole cost-report read of one pool, pages included. */
const CALL_TIMEOUT_MS = 30_000
const ANTHROPIC_VERSION = '2023-06-01'

const CostReport = z.object({
  data: z.array(z.object({ results: z.array(z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/) })) })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
})

export interface ReconcileStatus {
  reconciledAt: string | null
  reconcileError: string | null
}

type FailureKind = 'admin-key-missing' | 'timeout' | 'network' | 'malformed' | `http-${number}`

class ReportFailure extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind)
  }
}

const startOfUtcDay = (at: Date): Date => new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS)
const apiInstant = (at: Date): string => at.toISOString().replace('.000Z', 'Z')

/**
 * USD of the org in `[startingAt, endingAt)`, UTC day bounds: `GET /v1/organizations/cost_report` in daily buckets, every
 * page. `amount` is cents as a decimal string (docs/spikes/gateway/admin-api.md). The admin key goes in this one
 * header and nowhere else.
 */
async function costReportUsd(input: {
  baseUrl: string
  adminKey: string
  startingAt: Date
  endingAt: Date
}): Promise<number> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS)
  let cents = 0
  let page: string | null = null
  try {
    for (;;) {
      const url = new URL('/v1/organizations/cost_report', input.baseUrl)
      url.searchParams.set('starting_at', apiInstant(input.startingAt))
      url.searchParams.set('ending_at', apiInstant(input.endingAt))
      url.searchParams.set('bucket_width', '1d')
      url.searchParams.set('limit', '31')
      if (page !== null) url.searchParams.set('page', page)
      const response = await fetch(url, {
        headers: { 'x-api-key': input.adminKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal,
      })
      if (!response.ok) throw new ReportFailure(`http-${response.status}`)
      const report = CostReport.safeParse(await response.json())
      if (!report.success) throw new ReportFailure('malformed')
      for (const bucket of report.data.data) {
        for (const result of bucket.results) cents += Number(result.amount)
      }
      if (!report.data.has_more) return cents / 100
      if (!report.data.next_page) throw new ReportFailure('malformed')
      page = report.data.next_page
    }
  } catch (error) {
    if (error instanceof ReportFailure) throw error
    if (signal.aborted) throw new ReportFailure('timeout')
    if (error instanceof SyntaxError) throw new ReportFailure('malformed')
    throw new ReportFailure('network')
  }
}

/**
 * Spend made outside the gateway counts against the credit, and no API returns a balance. At boot and hourly: reconciled
 * = the cost report over the cycle's complete UTC days + the ledger since the start of the current UTC day (the report
 * has no row for today), handed to `pools.reconcile`, which keeps it as a floor, and stored. Any failure keeps the ledger
 * meter; at boot, the stored figure of the current cycle plus the ledger since it, so a restart during an Admin API
 * outage keeps the outside spend.
 */
export class Reconciler {
  private readonly state = new Map<string, ReconcileStatus>()
  /** Pool → the failure kinds already logged since its last success. */
  private readonly logged = new Map<string, Set<FailureKind>>()
  private readonly registry: RegistryPool[]
  private readonly adminKeys: ReadonlyMap<string, string>
  private readonly pools: Pick<Pools, 'reconcile'>
  private readonly ledger: MeterSource & FloorStore
  private readonly logger: Logger
  private readonly baseUrl: string
  private readonly now: () => Date
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: {
    /** The pools to reconcile: the enabled ones. */
    registry: RegistryPool[]
    adminKeys: ReadonlyMap<string, string>
    pools: Pick<Pools, 'reconcile'>
    ledger: MeterSource & FloorStore
    logger: Logger
    baseUrl: string
    now?: () => Date
  }) {
    this.registry = options.registry
    this.adminKeys = options.adminKeys
    this.pools = options.pools
    this.ledger = options.ledger
    this.logger = options.logger
    this.baseUrl = options.baseUrl
    this.now = options.now ?? (() => new Date())
  }

  status(pool: string): ReconcileStatus {
    return this.state.get(pool) ?? { reconciledAt: null, reconcileError: null }
  }

  /** Every pool once; never rejects. */
  async runAll(): Promise<void> {
    await Promise.all(this.registry.map((pool) => this.run(pool)))
  }

  /** The start's run: a pool whose live reconcile fails falls back on its stored figure. Never rejects. */
  async boot(): Promise<void> {
    await Promise.all(
      this.registry.map(async (pool) => {
        if (!(await this.run(pool))) this.restoreFloor(pool)
      }),
    )
  }

  start(): void {
    this.timer = setInterval(() => void this.runAll(), HOUR_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** True when the pool was reconciled. */
  private async run(pool: RegistryPool): Promise<boolean> {
    try {
      const adminKey = this.adminKeys.get(pool.id)
      if (adminKey === undefined) throw new ReportFailure('admin-key-missing')
      const at = this.now()
      const cycle = cycleOf(pool.cycleDay, at)
      const today = startOfUtcDay(at)
      const startingAt = startOfUtcDay(cycle.start)
      // A cycle that started today has no complete day, and the report refuses a start inside the current one.
      const reported =
        startingAt < today ? await costReportUsd({ baseUrl: this.baseUrl, adminKey, startingAt, endingAt: today }) : 0
      // One synchronous tick from here on: no charge may fall between the ledger read and the reconcile.
      const usd = reported + this.ledger.spentSince(pool.id, today)
      const reconciledAt = this.now()
      this.pools.reconcile(pool.id, usd, cycle.start.toISOString())
      this.store(pool, usd, reconciledAt)
      this.state.set(pool.id, { reconciledAt: reconciledAt.toISOString(), reconcileError: null })
      this.logged.delete(pool.id)
      return true
    } catch (error) {
      this.failed(pool.id, error)
      return false
    }
  }

  private cycleKey(pool: RegistryPool, start: Date): string {
    return pool.cycleDay === null ? ROLLING_KEY : start.toISOString()
  }

  /** A figure not stored costs one restart's fallback, never this reconcile. */
  private store(pool: RegistryPool, usd: number, at: Date): void {
    try {
      this.ledger.saveFloor(pool.id, this.cycleKey(pool, cycleOf(pool.cycleDay, at).start), { usd, at })
    } catch (error) {
      this.logger.warn(`reconcile ${pool.id}: the figure was not stored`, { error: errorMessage(error) })
    }
  }

  private restoreFloor(pool: RegistryPool): void {
    try {
      const at = this.now()
      const cycle = cycleOf(pool.cycleDay, at)
      const floor = this.ledger.floorOf(pool.id, this.cycleKey(pool, cycle.start))
      if (floor === null) return
      if (pool.cycleDay === null && at.getTime() - floor.at.getTime() > ROLLING_WINDOW_MS) return
      const usd = floor.usd + this.ledger.spentSince(pool.id, floor.at)
      this.pools.reconcile(pool.id, usd, cycle.start.toISOString())
      this.logger.info(`reconcile ${pool.id}: restored the stored figure`, { pool: pool.id, usd })
    } catch (error) {
      this.logger.warn(`reconcile ${pool.id}: the stored figure was not restored`, { error: errorMessage(error) })
    }
  }

  private failed(pool: string, error: unknown): void {
    const kind: FailureKind = error instanceof ReportFailure ? error.kind : 'malformed'
    const previous = this.status(pool)
    this.state.set(pool, { reconciledAt: previous.reconciledAt, reconcileError: kind })
    const logged = this.logged.get(pool) ?? new Set<FailureKind>()
    this.logged.set(pool, logged)
    if (logged.has(kind)) return
    logged.add(kind)
    this.logger.warn(`reconcile ${pool}: keeping the ledger meter`, { pool, kind })
  }
}
