/**
 * The one parser for a time flag (`--since`, `--until`, `--iu-since`): an ISO datetime passes through, a relative
 * duration (`30m`, `24h`, `7d`, `2w`) becomes the instant that long before `now`. Anything else is left for the host to
 * judge, so a host that accepts another form keeps it.
 */
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const
const RELATIVE = /^(\d+(?:\.\d+)?)([smhdw])$/i

/** A flag name that carries an instant: `since`, `until`, `iuSince`, `sinceUsed`-style names excluded on purpose. */
export const isWhenFlag = (name: string) => /^(since|until)$|(Since|Until)$/.test(name)

/** `7d` → the ISO instant seven days before `now`; an ISO datetime or any other text comes back unchanged. */
export function parseWhen(raw: string, now: number = Date.now()): string {
  const match = RELATIVE.exec(raw.trim())
  if (!match) return raw
  const unit = UNIT_MS[(match[2] as string).toLowerCase() as keyof typeof UNIT_MS]
  return new Date(now - Number(match[1]) * unit).toISOString()
}
