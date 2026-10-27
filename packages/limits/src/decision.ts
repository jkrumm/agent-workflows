import type { Logger } from '@agent-workflows/runtime'

export const METRICS = ['cost', 'tokens', 'wallMs', 'steps'] as const
export type Metric = (typeof METRICS)[number]

/** One value per metric: cost in USD, tokens (input + output + cache read + reasoning), wall time in ms, steps. */
export type Metrics = Record<Metric, number>

/** Where a run's caps came from: the workflow's own history, or the static ceiling below the sample minimum. */
export type CapBasis =
  | { kind: 'learned'; sample: number; factor: number; p95: Metrics }
  | { kind: 'static'; sample: number; reason: 'below_sample_minimum' | 'history_unavailable' }

export type Caps = { values: Metrics; basis: CapBasis }

export type CapDecision = {
  rule: 'runaway-cap'
  hook: 'stepPre' | 'toolPre'
  runId: string
  workflowId: string
  stepId: string
  allowed: boolean
  /** The run's accumulated usage, including what it spent before a resume. */
  observed: Metrics
  caps: Metrics
  basis: CapBasis
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
