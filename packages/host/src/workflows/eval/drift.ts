import type { Logger, Runtime } from '@agent-workflows/runtime'

export type DriftOptions = {
  /** Share of finished production runs scored, 0..1. Default 0.1; 0 turns drift off. */
  rate: number
  /** Tick. Default 5 min. */
  intervalMs: number
  /** Only runs finished this recently are sampled. Default 7 days. */
  lookbackMs: number
  /** Runs scored per tick at most. Default 20. */
  batch: number
}

export const DEFAULT_DRIFT: DriftOptions = { rate: 0.1, intervalMs: 5 * 60_000, lookbackMs: 7 * 86_400_000, batch: 20 }

/** `AGW_DRIFT_RATE` (0..1) and `AGW_DRIFT_INTERVAL_S` override the defaults; anything unparsable is refused at boot. */
export function driftOptionsFromEnv(env: Record<string, string | undefined>): DriftOptions {
  const options = { ...DEFAULT_DRIFT }
  const rate = env.AGW_DRIFT_RATE?.trim()
  if (rate) {
    const value = Number(rate)
    if (!(value >= 0 && value <= 1)) throw new Error(`AGW_DRIFT_RATE must be a number in [0, 1], got "${rate}"`)
    options.rate = value
  }
  const interval = env.AGW_DRIFT_INTERVAL_S?.trim()
  if (interval) {
    const value = Number(interval)
    if (!(Number.isInteger(value) && value > 0))
      throw new Error(`AGW_DRIFT_INTERVAL_S must be a positive integer, got "${interval}"`)
    options.intervalMs = value * 1000
  }
  return options
}

/**
 * Drift (concept §6): a sample of finished production runs of every workflow with a scorer, scored after the fact.
 * The sample is a hash threshold on the run id (`Runtime.driftCandidates`), the same in every process and tick, and
 * the write is first-writer-wins (`onlyUnscored`), so a run is scored once however many hosts tick. The default
 * scorers are deterministic: drift costs no model call.
 */
export class DriftJob {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<number> | null = null
  private stopped = false

  constructor(
    private readonly runtime: Pick<Runtime, 'driftCandidates' | 'scoreRun'>,
    private readonly options: DriftOptions,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** One pass: the next batch of sampled, unscored runs. Returns how many it scored. */
  async tick(): Promise<number> {
    if (this.options.rate <= 0) return 0
    const ids = await this.runtime.driftCandidates({
      rate: this.options.rate,
      since: new Date(this.now() - this.options.lookbackMs),
      limit: this.options.batch,
    })
    let scored = 0
    for (const runId of ids) {
      if (this.stopped) break
      try {
        if (await this.runtime.scoreRun(runId, { source: 'drift', onlyUnscored: true })) scored++
      } catch (error) {
        this.logger.warn('drift: scoring a run failed; retried next tick', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return scored
  }

  start(): void {
    if (this.options.rate <= 0 || this.stopped) return
    const schedule = () => {
      if (this.stopped) return
      this.timer = setTimeout(() => {
        this.running = this.tick().catch((error: unknown) => {
          this.logger.warn('drift tick failed', { error: error instanceof Error ? error.message : String(error) })
          return 0
        })
        void this.running.finally(() => {
          this.running = null
          schedule()
        })
      }, this.options.intervalMs)
      this.timer.unref?.()
    }
    schedule()
  }

  /** Stops ticking and waits for a tick in flight. Before the runtime closes. */
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
  }
}
