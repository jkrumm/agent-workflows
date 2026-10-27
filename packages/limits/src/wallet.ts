import { AdmissionRefused, type Logger, type Middleware, type RunPreArgs } from '@agent-workflows/runtime'
import { consoleLogger, type DecisionSink, type WalletDecision } from './decision.ts'
import { defaultSnapshotPath, type SpendSource, snapshotSpendSource } from './spend.ts'

export const WALLET_THRESHOLD_USD_DEFAULT = 400
/** Owner decision 2026-10-26: no OCR while the IU API is over its rolling cap. */
export const WALLET_PAUSED_UNTIL_DEFAULT = '2026-11-02T00:00:00Z'

export type WalletGateOptions = {
  /** Workflow ids declared optional-expensive; every other workflow passes untouched. */
  workflows: Iterable<string>
  /** Default: usage-tracker's snapshot at `AGW_WALLET_SNAPSHOT` or `~/.local/share/iu-portal/latest.json`. */
  spend?: SpendSource
  /** Refuse at or above this IU rolling-30-day spend (USD); 0 disables the spend check. Default `AGW_WALLET_THRESHOLD_USD` or 400. */
  thresholdUsd?: number
  /** Refuse while now is before this; null for no pause. Default `AGW_WALLET_PAUSED_UNTIL` or 2026-11-02. */
  pausedUntil?: Date | null
  now?: () => Date
  logger?: Logger
  onDecision?: DecisionSink
}

/**
 * Refuses optional expensive work at admission, never mid-run (concept §4 Money, N8): a new run of a configured
 * workflow is refused while paused or while the IU rolling-30-day spend is at or above the threshold, and on any
 * spend reading that is not trustworthy (fail closed). A resumed run is always admitted.
 */
export function walletGate(options: WalletGateOptions): Middleware {
  const workflows = new Set(options.workflows)
  const logger = options.logger ?? consoleLogger
  const env = walletEnv(process.env, logger)
  const spend = options.spend ?? snapshotSpendSource({ path: env.snapshotPath })
  const thresholdUsd = options.thresholdUsd ?? env.thresholdUsd
  const pausedUntil = options.pausedUntil === undefined ? env.pausedUntil : options.pausedUntil
  const now = options.now ?? (() => new Date())
  const emit = options.onDecision ?? (() => {})

  return {
    name: 'wallet-gate',
    async runPre(args: RunPreArgs) {
      if (!workflows.has(args.workflowId)) return
      const base = {
        rule: 'wallet-gate' as const,
        runId: args.runId,
        workflowId: args.workflowId,
        resume: args.resume,
        thresholdUsd,
        pausedUntil: pausedUntil?.toISOString() ?? null,
      }
      if (args.resume) {
        emit({ ...base, allowed: true, reason: 'resume', rolling30Usd: null })
        return
      }
      const at = now()
      let rolling30Usd: number | null = null
      let reason: string | null = null
      if (pausedUntil && at < pausedUntil) {
        reason = `paused until ${pausedUntil.toISOString()} (IU cap cooldown)`
      } else if (thresholdUsd > 0) {
        const reading = await spend.read(at).catch((err: unknown) => ({
          ok: false as const,
          reason: `IU spend source failed: ${err instanceof Error ? err.message : String(err)}`,
        }))
        if (!reading.ok) reason = reading.reason
        else {
          rolling30Usd = reading.rolling30Usd
          if (rolling30Usd >= thresholdUsd) {
            reason = `IU rolling 30d $${Math.round(rolling30Usd * 100) / 100} >= $${thresholdUsd} wallet gate`
          }
        }
      }
      const decision: WalletDecision = { ...base, allowed: reason === null, reason, rolling30Usd }
      emit(decision)
      if (reason === null) return
      logger.warn('wallet gate refused admission', decision)
      throw new AdmissionRefused(`wallet gate: ${reason}`)
    },
  }
}

export type WalletEnv = { thresholdUsd: number; pausedUntil: Date | null; snapshotPath: string }

/**
 * `AGW_WALLET_THRESHOLD_USD` (a number ≥ 0; anything else → a warning and 400), `AGW_WALLET_PAUSED_UNTIL` (ISO date; empty =
 * no pause; invalid → warning, no pause), `AGW_WALLET_SNAPSHOT` (path).
 */
export function walletEnv(env: Record<string, string | undefined>, logger: Logger = consoleLogger): WalletEnv {
  const rawThreshold = env.AGW_WALLET_THRESHOLD_USD?.trim()
  const threshold = Number(rawThreshold)
  const valid = Number.isFinite(threshold) && threshold >= 0
  const set = rawThreshold !== undefined && rawThreshold !== ''
  if (set && !valid) {
    logger.warn('AGW_WALLET_THRESHOLD_USD is not a number >= 0; the default applies', {
      thresholdUsd: rawThreshold,
      default: WALLET_THRESHOLD_USD_DEFAULT,
    })
  }
  const thresholdUsd = set && valid ? threshold : WALLET_THRESHOLD_USD_DEFAULT

  const rawPause = env.AGW_WALLET_PAUSED_UNTIL ?? WALLET_PAUSED_UNTIL_DEFAULT
  let pausedUntil: Date | null = null
  if (rawPause !== '') {
    const until = new Date(rawPause)
    if (Number.isNaN(until.getTime())) {
      logger.warn('AGW_WALLET_PAUSED_UNTIL is not a valid date; no pause', { pausedUntil: rawPause })
    } else pausedUntil = until
  }

  return { thresholdUsd, pausedUntil, snapshotPath: env.AGW_WALLET_SNAPSHOT || defaultSnapshotPath() }
}
