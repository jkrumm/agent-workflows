import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fail } from '../errors.ts'

// A daily read budget per shop host, kept in the shop data directory (`reads.json`): every page the shop doors read over the
// network counts one, a cache hit counts none, and a host with a cap refuses the read that would pass it. idealo.de turned
// this machine away after about 130 reads in eight hours (2026-11-17) and then refused the browser too until the next
// morning, so the door stops short of the wall instead of meeting it.

/** The caps a host has unless the environment says otherwise (`AGW_SHOP_DAILY_CAP`). Hosts not named have none. */
export const DEFAULT_DAILY_CAPS: Readonly<Record<string, number>> = { 'www.idealo.de': 80 }

const KEEP_DAYS = 14

export interface ReadCount {
  host: string
  /** The local calendar day the count is for, `YYYY-MM-DD`. */
  day: string
  /** Pages read from the host today, over the network. */
  count: number
  /** The most reads of the host a day; null when it has no cap. */
  cap: number | null
}

export interface ReadBudget {
  /** Counts one read of `host` and returns the count, or throws when the host's cap for today is already used. */
  take(host: string): Promise<ReadCount>
  /** Today's count for `host`, without counting. */
  today(host: string): Promise<ReadCount>
}

/** The directory of the shop's files: `AGW_SHOP_DIR`, else `~/.agent-workflows/data/shop`. */
export const shopDataDir = (env: Record<string, string | undefined>): string =>
  env.AGW_SHOP_DIR?.trim() || join(homedir(), '.agent-workflows', 'data', 'shop')

/**
 * `AGW_SHOP_DAILY_CAP="www.idealo.de=60,geizhals.de=40"` replaces the default cap of the hosts it names; `host=0` lifts the cap of
 * that host. An entry that is no `host=number` is an error, not silently ignored: a typo would otherwise lift the cap.
 */
export function parseDailyCaps(raw: string | undefined): Record<string, number> {
  const caps: Record<string, number> = { ...DEFAULT_DAILY_CAPS }
  for (const entry of (raw ?? '').split(',')) {
    const text = entry.trim()
    if (!text) continue
    const match = text.match(/^([a-z0-9.-]+)=(\d+)$/i)
    if (!match) throw fail('NOT_CONFIGURED', `shop: AGW_SHOP_DAILY_CAP entry "${text}" is not host=number`)
    if (Number(match[2]) === 0) delete caps[match[1]!.toLowerCase()]
    else caps[match[1]!.toLowerCase()] = Number(match[2])
  }
  return caps
}

type Counts = Record<string, Record<string, number>>

/** `YYYY-MM-DD` of the machine's local day. */
const dayOf = (at: number) => {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function createReadBudget(args: {
  dir: string
  now: () => number
  /** Read on every call, so a changed or malformed `AGW_SHOP_DAILY_CAP` is met at the read, not when the doors are built. */
  caps?: () => Record<string, number>
}): ReadBudget {
  const path = join(args.dir, 'reads.json')

  async function load(): Promise<Counts> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw fail(
        'UPSTREAM_ERROR',
        `shop.fetch: the read counter ${path} cannot be read: ${(error as Error).message}`,
        {},
      )
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Counts
    } catch {
      // A reset counter would lift the cap without anyone noticing, so a damaged file stops the read.
      throw fail('UPSTREAM_ERROR', `shop.fetch: the read counter ${path} is not valid JSON; fix or remove it`, {})
    }
  }

  const view = (counts: Counts, host: string): ReadCount => {
    const day = dayOf(args.now())
    return { host, day, count: counts[day]?.[host] ?? 0, cap: (args.caps?.() ?? DEFAULT_DAILY_CAPS)[host] ?? null }
  }

  return {
    async today(host) {
      return view(await load(), host)
    },
    async take(host) {
      const counts = await load()
      const before = view(counts, host)
      if (before.cap !== null && before.count >= before.cap)
        throw fail(
          'UPSTREAM_ERROR',
          `shop.fetch: daily read cap reached for ${host}: ${before.count} of ${before.cap} on ${before.day}, nothing sent (raise it with AGW_SHOP_DAILY_CAP, or wait for tomorrow)`,
          {},
        )
      const keep = Object.keys(counts)
        .sort()
        .slice(-KEEP_DAYS + 1)
        .filter((day) => day !== before.day)
      const next: Counts = Object.fromEntries(keep.map((day) => [day, counts[day]!]))
      next[before.day] = { ...counts[before.day], [host]: before.count + 1 }
      await mkdir(args.dir, { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
      await rename(tmp, path)
      return { ...before, count: before.count + 1 }
    },
  }
}
