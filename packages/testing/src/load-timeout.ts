import { availableParallelism, loadavg } from 'node:os'
import { setDefaultTimeout } from 'bun:test'

export const FLOOR_MS = 5000
export const CAP_MS = 30000

export interface LoadSource {
  /** 1-minute load average. */
  load: () => number
  cores: () => number
  /** Applies the default timeout to tests registered afterwards. */
  apply: (ms: number) => void
}

export const hostLoad: LoadSource = {
  load: () => loadavg()[0] ?? 0,
  cores: availableParallelism,
  apply: setDefaultTimeout,
}

/** 5000 ms per unit of load-per-core, clamped to [FLOOR_MS, CAP_MS]. */
export function loadScaledTimeoutMs(source: LoadSource = hostLoad): number {
  const perCore = source.load() / Math.max(1, source.cores())
  return Math.round(Math.min(CAP_MS, Math.max(FLOOR_MS, FLOOR_MS * perCore)))
}

/** Samples the load now and makes it the default timeout for tests registered from here on. */
export function applyLoadScaledTimeout(source: LoadSource = hostLoad): number {
  const ms = loadScaledTimeoutMs(source)
  source.apply(ms)
  return ms
}
