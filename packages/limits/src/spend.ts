import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SpendReading = { ok: true; rolling30Usd: number; fetchedAt: Date } | { ok: false; reason: string }

/** The port the wallet gate reads the IU rolling-30-day spend through. `ok: false` refuses admission. */
export type SpendSource = { read(now: Date): Promise<SpendReading> }

/** A snapshot older than this no longer says anything about the current spend. */
export const SNAPSHOT_MAX_AGE_MS = 48 * 60 * 60 * 1000

/** A `fetched_at` further ahead than this is a wrong clock, not a fresh snapshot. */
const FUTURE_SKEW_MS = 5 * 60 * 1000

/** Where usage-tracker's host-side writer drops the IU spend snapshot. */
export function defaultSnapshotPath(): string {
  return join(homedir(), '.local', 'share', 'iu-portal', 'latest.json')
}

/**
 * Reads usage-tracker's IU snapshot (`{ schema: 1, fetched_at, rolling30_usd }`) on every call; it is tiny.
 * Fails closed: a missing, unreadable, malformed or stale snapshot is a reading that refuses, because the gate
 * exists for the time the IU API is over its cap. Ported from agent-gateway's `ocrBudgetBlockReason`.
 */
export function snapshotSpendSource(options: { path?: string; maxAgeMs?: number } = {}): SpendSource {
  const path = options.path ?? defaultSnapshotPath()
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS
  return {
    async read(now) {
      let raw: string
      try {
        raw = await readFile(path, 'utf-8')
      } catch (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        return { ok: false, reason: missing ? 'IU spend snapshot missing' : 'IU spend snapshot unreadable' }
      }
      let snap: unknown
      try {
        snap = JSON.parse(raw)
      } catch {
        return { ok: false, reason: 'IU spend snapshot is not valid JSON' }
      }
      if (!snap || typeof snap !== 'object' || (snap as { schema?: unknown }).schema !== 1) {
        return { ok: false, reason: 'IU spend snapshot has an unsupported schema' }
      }
      const { fetched_at, rolling30_usd } = snap as { fetched_at?: unknown; rolling30_usd?: unknown }
      const fetchedAt = typeof fetched_at === 'string' ? Date.parse(fetched_at) : Number.NaN
      if (Number.isNaN(fetchedAt)) return { ok: false, reason: 'IU spend snapshot has no valid fetched_at' }
      if (fetchedAt - now.getTime() > FUTURE_SKEW_MS) {
        return { ok: false, reason: 'IU spend snapshot has fetched_at in the future' }
      }
      if (now.getTime() - fetchedAt > maxAgeMs) {
        return { ok: false, reason: `IU spend snapshot is stale (fetched_at older than ${maxAgeMs / 3_600_000} h)` }
      }
      if (typeof rolling30_usd !== 'number' || !Number.isFinite(rolling30_usd)) {
        return { ok: false, reason: 'IU spend snapshot has no valid rolling30_usd' }
      }
      return { ok: true, rolling30Usd: rolling30_usd, fetchedAt: new Date(fetchedAt) }
    },
  }
}
