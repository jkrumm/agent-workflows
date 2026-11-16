// One reading of a `--since` flag for a host read operation: an ISO date or timestamp, or a duration back from now
// (`30m`, `24h`, `7d`, `2w`). Not for a workflow input: its hash must not move with the clock.
const DURATION = /^(\d+)([mhdw])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const

export const SINCE_HINT =
  'an ISO date or timestamp (2026-10-01, 2026-10-01T00:00:00Z) or a duration back from now (30m, 24h, 7d, 2w)'

/** The instant a duration reaches back to, or null when `value` is not a duration. */
export function durationAgo(value: string, nowMs: number): Date | null {
  const match = DURATION.exec(value.trim())
  if (!match) return null
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
  return Number.isSafeInteger(ms) ? new Date(nowMs - ms) : null
}

/** A duration back from `nowMs`, or an ISO instant; null for anything else (never a guess). */
export function parseSince(value: string, nowMs: number): Date | null {
  const ago = durationAgo(value, nowMs)
  if (ago) return ago
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
