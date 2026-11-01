import { z } from 'zod'
import type { Logger } from './log.ts'
import { cycleOf, type MeterSource, type Pools, type RegistryPool } from './pools/index.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
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
 * has no row for today), handed to `pools.reconcile`, which keeps it as a floor. Any failure keeps the ledger meter.
 */
export class Reconciler {
  private readonly state = new Map<string, ReconcileStatus>()
  /** Pool → the failure kinds already logged since its last success. */
  private readonly logged = new Map<string, Set<FailureKind>>()
  private readonly registry: RegistryPool[]
  private readonly adminKeys: ReadonlyMap<string, string>
  private readonly pools: Pick<Pools, 'reconcile'>
  private readonly ledger: MeterSource
  private readonly logger: Logger
  private readonly baseUrl: string
  private readonly now: () => Date
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: {
    /** The pools to reconcile: the enabled ones. */
    registry: RegistryPool[]
    adminKeys: ReadonlyMap<string, string>
    pools: Pick<Pools, 'reconcile'>
    ledger: MeterSource
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

  start(): void {
    this.timer = setInterval(() => void this.runAll(), HOUR_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private async run(pool: RegistryPool): Promise<void> {
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
      this.pools.reconcile(pool.id, reported + this.ledger.spentSince(pool.id, today), cycle.start.toISOString())
      this.state.set(pool.id, { reconciledAt: this.now().toISOString(), reconcileError: null })
      this.logged.delete(pool.id)
    } catch (error) {
      this.failed(pool.id, error)
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
