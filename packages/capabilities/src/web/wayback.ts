import { z } from 'zod'
import { describe, isAbort } from '../transports/http.ts'
import { type ResolvedWebDeps, within } from './deps.ts'
import { isChallenge } from './browser.ts'
import { incompleteReason } from './pages.ts'

/**
 * The Internet Archive leg of `web.fetch`: a page the plain and browser reads could not get past a wall is read from the
 * Wayback Machine's newest copy, when that copy is recent enough to stand for the page. The answer is an archived copy,
 * says so with the snapshot's date, and never replaces a `fresh` read (`fetch.ts` skips this leg then).
 *
 * `GET https://archive.org/wayback/available?url=<url>` answers `{ archived_snapshots: { closest: { available, url,
 * timestamp: 'YYYYMMDDhhmmss' (UTC), status } } }`, or `{ archived_snapshots: {} }` when there is none (archive.org/help/
 * wayback_api.php, read 2026-11-16; the docs state no rate limit). Without a `timestamp` the closest copy is the newest.
 */

const AVAILABILITY = 'https://archive.org/wayback/available'
const TIMEOUT_MS = 10_000
const DAY_MS = 86_400_000

/**
 * A copy older than this is not offered. A page behind a bot wall is usually one that changes (a job list, a thread, a
 * price), so an old copy is only worth giving when it says how old it is, which every answer does. Picked from the
 * replay of 2026-11-16 over 13 pages whose plain read was refused (README, `web.fetch` chain): copies up to 30 days old
 * answered 5, up to 180 days 8, up to 365 days 9; the ninth was a Stack Overflow question the API leg reads live. 180
 * is where the rate stops rising for pages only this leg can answer.
 */
export const WAYBACK_MAX_AGE_DAYS = 180

const availability = z.object({
  archived_snapshots: z
    .object({
      closest: z
        .object({
          available: z.boolean().optional(),
          url: z.string().optional(),
          timestamp: z.string().regex(/^\d{14}$/),
          status: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
})

export type SnapshotResult =
  | { ok: true; snapshotUrl: string; at: Date }
  | { ok: false; outcome: 'missing' | 'failed' | 'timeout'; message: string }

const miss = (outcome: 'missing' | 'failed' | 'timeout', message: string): SnapshotResult => ({
  ok: false,
  outcome,
  message: `wayback: ${message}`,
})

/** `20261116093045` as a UTC date. */
function parseTimestamp(raw: string): Date {
  const [y, mo, d, h, mi, s] = [
    raw.slice(0, 4),
    raw.slice(4, 6),
    raw.slice(6, 8),
    raw.slice(8, 10),
    raw.slice(10, 12),
    raw.slice(12, 14),
  ]
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
}

/**
 * The newest snapshot of `url`, as the address to read it from and the time it was taken, or why there is none: no copy,
 * one that was no successful page, or one older than `maxAgeDays`. The address is the raw capture (`id_`): the original
 * bytes without the archive's toolbar and link rewriting.
 */
export async function findSnapshot(
  deps: ResolvedWebDeps,
  url: string,
  signal: AbortSignal,
  options: { now?: number; maxAgeDays?: number } = {},
): Promise<SnapshotResult> {
  const now = options.now ?? Date.now()
  const maxAgeDays = options.maxAgeDays ?? WAYBACK_MAX_AGE_DAYS
  let target: string
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    target = parsed.toString()
  } catch {
    return miss('failed', 'not a URL')
  }
  let body: unknown
  try {
    const res = await deps.fetch(`${AVAILABILITY}?${new URLSearchParams({ url: target })}`, {
      headers: { accept: 'application/json', 'user-agent': 'agent-workflows/0.1 (web.fetch)' },
      signal: within(signal, TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return miss('failed', `HTTP ${res.status}`)
    }
    body = await res.json()
  } catch (error) {
    if (signal.aborted) throw error
    return miss(isAbort(error) ? 'timeout' : 'failed', isAbort(error) ? 'timed out' : describe(error))
  }
  const parsed = availability.safeParse(body)
  if (!parsed.success) return miss('failed', 'unreadable answer')
  const closest = parsed.data.archived_snapshots?.closest
  if (!closest || closest.available === false) return miss('missing', 'no snapshot of the page')
  if (closest.status && !/^2\d\d$/.test(closest.status))
    return miss('missing', `the newest snapshot is a ${closest.status}`)
  const at = parseTimestamp(closest.timestamp)
  const ageDays = Math.floor((now - at.getTime()) / DAY_MS)
  if (ageDays > maxAgeDays) return miss('missing', `the newest snapshot is ${ageDays} days old (limit ${maxAgeDays})`)
  return { ok: true, snapshotUrl: `https://web.archive.org/web/${closest.timestamp}id_/${target}`, at }
}

/** The wording of walls that is not in `isChallenge`'s title list, matched in the opening of a short snapshot. */
const WALL_TEXT =
  /captcha|are you (a )?(robot|human)|verify you are human|unusual traffic|additional verification|pardon our interruption|enable cookies|incapsula|datadome|request unsuccessful/i
const SHORT_WALL_CHARS = 1_500

/**
 * Why a snapshot is no answer, or undefined when it reads as the page. The archive keeps what the crawler was served,
 * and a walled page is often captured as the wall itself: the same challenge and incomplete-page checks the live reads
 * pass must pass here.
 */
export function snapshotMiss(
  read: { finalUrl: string; title?: string; text: string; incomplete?: string },
  original: string,
): string | undefined {
  if (isChallenge(read.title ?? '', read.text)) return 'the snapshot is a bot-check page'
  if (read.text.length < SHORT_WALL_CHARS && WALL_TEXT.test(read.text.slice(0, 600)))
    return 'the snapshot is a bot-check page'
  return read.incomplete ?? incompleteReason(original, read.text)
}

/** The line that opens an archived answer: what it is, when it was taken, where from. */
export function archiveNotice(at: Date, snapshotUrl: string): string {
  return `[Archived copy: Internet Archive snapshot taken ${at.toISOString().slice(0, 10)}, not the live page. ${snapshotUrl}]`
}
