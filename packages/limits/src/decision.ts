import type { Logger } from '@agent-workflows/runtime'

export const METRICS = ['cost', 'tokens', 'wallMs', 'steps'] as const
export type Metric = (typeof METRICS)[number]

/** One value per metric: cost in USD, tokens (input + output + cache read + reasoning), wall time in ms, steps. */
export type Metrics = Record<Metric, number>

/** Where a group of caps came from: the workflow's own history, or the static ceiling. */
export type CapBasis =
  | { kind: 'learned'; sample: number; factor: number }
  | { kind: 'static'; sample: number; reason: 'below_sample_minimum' | 'history_unavailable' | 'history_pending' }

/**
 * A workflow's caps. Cost, tokens and wall time (`tree`) are learned from its top-level runs, summed over each run's
 * whole tree (fan-out children included); steps from all its runs, each counted on its own.
 */
export type Caps = { values: Metrics; p95: Partial<Metrics>; basis: { tree: CapBasis; steps: CapBasis } }

export type CapDecision = {
  rule: 'runaway-cap'
  hook: 'stepPre' | 'toolPre'
  runId: string
  rootId: string
  workflowId: string
  stepId: string
  allowed: boolean
  /**
   * Cost, tokens and wall time of the whole root run tree, steps of this run; what was spent before a resume
   * included.
   */
  observed: Metrics
  /** Cost, tokens and wall time from the root workflow's caps, steps from this run's workflow. */
  caps: Metrics
  basis: { tree: CapBasis; steps: CapBasis }
  /** Usage reports without a price in the tree: cost is a lower bound and the token cap is the binding check. */
  unpricedCalls: number
  exceeded: Metric | null
}

export type WalletDecision = {
  rule: 'wallet-gate'
  runId: string
  workflowId: string
  resume: boolean
  allowed: boolean
  /** Why it was refused, or why it was allowed without a spend check (`resume`). */
  reason: string | null
  rolling30Usd: number | null
  thresholdUsd: number
  pausedUntil: string | null
}

/** What both rules saw, for the record middleware to store later. */
export type LimitDecision = CapDecision | WalletDecision

export type DecisionSink = (decision: LimitDecision) => void

export const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-limits] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-limits] ${message}`, meta ?? ''),
}

/** Wraps `onDecision` so a throwing (or rejecting) sink is logged and never refuses or fails anything. */
export function isolatedSink(sink: DecisionSink | undefined, logger: Logger): DecisionSink {
  if (!sink) return () => {}
  const report = (decision: LimitDecision, err: unknown) =>
    logger.error('onDecision threw; ignored', {
      rule: decision.rule,
      runId: decision.runId,
      error: err instanceof Error ? err.message : String(err),
    })
  return (decision) => {
    try {
      const result: unknown = sink(decision)
      if (result instanceof Promise) result.catch((err: unknown) => report(decision, err))
    } catch (err) {
      report(decision, err)
    }
  }
}
