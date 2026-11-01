const DAY_MS = 86_400_000
/** An unknown cycle meters a rolling window this long: never shorter than a real cycle, so it never under-counts. */
export const ROLLING_WINDOW_MS = 31 * DAY_MS

/** 00:00 UTC on day `day` of the month `month` (may overflow into a neighbouring year), clamped to the month's last day. */
function anchor(year: number, month: number, day: number): Date {
  const first = new Date(Date.UTC(year, month, 1))
  const y = first.getUTCFullYear()
  const m = first.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)))
}

/**
 * The credit cycle containing `now`. `cycleDay` is the credit's expiry day (Console Billing), not the payment day: a
 * cycle runs from the previous expiry, 00:00 UTC on the most recent occurrence of that day, to the next expiry (both
 * clamped to short months: 31 → Feb 28/29). The expiry instant belongs to the new cycle. `null` (expiry unknown) is a
 * rolling 31-day window ending now, with no known end.
 */
export function cycleOf(cycleDay: number | null, now: Date): { start: Date; end: Date | null } {
  if (cycleDay === null) return { start: new Date(now.getTime() - ROLLING_WINDOW_MS), end: null }
  if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 31) {
    throw new RangeError(`cycleDay must be an integer 1–31, got ${cycleDay}`)
  }

  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const thisMonth = anchor(year, month, cycleDay)
  if (now.getTime() >= thisMonth.getTime()) return { start: thisMonth, end: anchor(year, month + 1, cycleDay) }
  return { start: anchor(year, month - 1, cycleDay), end: thisMonth }
}
