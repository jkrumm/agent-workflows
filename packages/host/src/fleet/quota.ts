import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { type AccountQuota, LANE_PICKS, type LanePick, type LanePicks } from './schema.ts'

// Multi-account Claude Max quota. The cache is owned by the dotfiles CLI `claude-account`; `claude-account usage --json`
// reads only its local cache files (no network, ~100 ms). This module runs it, merges in the numbers a statusline
// reports, and renders the two-line quota header of the overview pane.

const CLI_TIMEOUT_MS = 5_000
const MEMO_MS = 15_000
/** Distinct reported accounts beyond the CLI's registry that `record` accepts. */
export const ACCOUNT_SLACK = 4
/** A sample older than this is `stale`: the picker's eligibility cutoff. */
export const STALE_AFTER_MS = 6 * 3600 * 1000
/** Account id shape: the one definition, used by the CLI parser and the report body. */
export const ACCOUNT_ID_PATTERN = '^[a-z][a-z0-9-]{0,15}$'
const ACCOUNT_ID_RE = new RegExp(ACCOUNT_ID_PATTERN)
export const DEFAULT_ACCOUNT = 'iu'

const nullableNum = z.number().nullable().optional()

const CLI_ACCOUNT = z.object({
  id: z.string().regex(ACCOUNT_ID_RE),
  plan: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  five_hour: nullableNum,
  seven_day: nullableNum,
  five_hour_resets_at: nullableNum,
  seven_day_resets_at: nullableNum,
  age_s: nullableNum,
  five_hour_age_s: nullableNum,
  seven_day_age_s: nullableNum,
  source: z.string().nullable().optional(),
  auth_ok: z.boolean().nullable().optional(),
  exhausted_until: nullableNum,
})
// One malformed account row never hides the others: rows are validated one by one.
const CLI_OUTPUT = z.object({ accounts: z.array(z.unknown()) })

export type CliAccount = z.infer<typeof CLI_ACCOUNT>

export interface CliUsage {
  /** Epoch ms the CLI was run: the base for every `*_age_s`. */
  fetchedAt: number
  accounts: CliAccount[]
}

/** Parses `claude-account usage --json` stdout. Null on garbage; invalid rows are dropped. */
export function parseClaudeUsage(stdout: string, fetchedAt: number): CliUsage | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const top = CLI_OUTPUT.safeParse(raw)
  if (!top.success) return null
  const accounts: CliAccount[] = []
  for (const row of top.data.accounts) {
    const parsed = CLI_ACCOUNT.safeParse(row)
    if (parsed.success) accounts.push(parsed.data)
  }
  return { fetchedAt, accounts }
}

const PICK_WHY_LINE_RE = /^#\s*picked=(\S+)\s+reason=(\S+)\s+stale=(true|false)\s*$/

/**
 * `claude-account pick --lane <lane> --dry --why`: the trailing `# picked=<id> reason=<reason> stale=<bool>` comment, on
 * exit 0 (an account or the default) or 3 (the spill signal, `picked` is `spill`). Any other exit is unavailable.
 */
export function parseAccountPickWhy(stdout: string, exitCode: number): LanePick | null {
  if (exitCode !== 0 && exitCode !== 3) return null
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PICK_WHY_LINE_RE.exec(lines[i]?.trim() ?? '')
    if (m?.[1] && m[2]) return { picked: m[1], reason: m[2], stale: m[3] === 'true' }
  }
  return null
}

/** The picker CLI, as a port: `null` on any failure (spawn error, timeout, an exit other than 0, or 3 for `pick`). */
export type AccountCli = (args: string[]) => Promise<{ stdout: string; exitCode: number } | null>

/** The real CLI with the four variables it needs to find bun, the keychain and a temp dir, never the parent's credentials. */
export function claudeAccountCli(options: { bin?: string; env?: Record<string, string | undefined> } = {}): AccountCli {
  const env = options.env ?? process.env
  const bin = options.bin ?? (env.AGW_CLAUDE_ACCOUNT_BIN?.trim() || join(homedir(), '.local', 'bin', 'claude-account'))
  const childEnv: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: CLI_TIMEOUT_MS, env: childEnv, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code
        if (!error) return resolve({ stdout, exitCode: 0 })
        // Exit 3 is the picker's spill signal; for any other subcommand it is just a failure.
        resolve(code === 3 && args[0] === 'pick' ? { stdout, exitCode: 3 } : null)
      })
    })
}

/** A statusline report, kept in memory per account (lost on a restart; the next render reports again). */
export interface PostedUsage {
  five_hour_pct: number
  five_hour_mins_left: number | null
  seven_day_pct: number | null
  updated_at: number
}

const minsLeft = (resetsAtS: number | null, now: number): number | null =>
  resetsAtS == null ? null : Math.max(0, Math.ceil((resetsAtS * 1000 - now) / 60_000))

/** One account's object from the CLI row (either may be absent) and its last report. Per window, a newer report wins. */
export function mergeAccountQuota(
  cli: CliAccount | undefined,
  cliFetchedAt: number,
  post: PostedUsage | null,
  now: number,
): AccountQuota {
  const windowTs = (ageS: number | null | undefined, fallbackAgeS: number | null | undefined) => {
    const age = ageS ?? fallbackAgeS
    return age == null ? null : cliFetchedAt - age * 1000
  }
  const fiveTs = windowTs(cli?.five_hour_age_s, cli?.age_s)
  const sevenTs = windowTs(cli?.seven_day_age_s, cli?.age_s)

  let fiveHourPct = cli?.five_hour ?? null
  let fiveResets = cli?.five_hour_resets_at ?? null
  let sevenPct = cli?.seven_day ?? null
  let updatedAt = fiveTs != null && sevenTs != null ? Math.max(fiveTs, sevenTs) : (fiveTs ?? sevenTs)
  let source = cli?.source ?? null

  if (post && (fiveTs == null || post.updated_at > fiveTs)) {
    fiveHourPct = post.five_hour_pct
    // Only a report that carries minutes-left moves the reset; otherwise the CLI's stays.
    if (post.five_hour_mins_left != null) {
      fiveResets = Math.round(post.updated_at / 1000 + post.five_hour_mins_left * 60)
    }
    updatedAt = Math.max(updatedAt ?? 0, post.updated_at)
    source = 'post'
  }
  if (post && post.seven_day_pct != null && (sevenTs == null || post.updated_at > sevenTs)) {
    sevenPct = post.seven_day_pct
    updatedAt = Math.max(updatedAt ?? 0, post.updated_at)
    source = 'post'
  }

  return {
    five_hour_pct: fiveHourPct,
    seven_day_pct: sevenPct,
    five_hour_resets_at: fiveResets,
    seven_day_resets_at: cli?.seven_day_resets_at ?? null,
    five_hour_mins_left: minsLeft(fiveResets, now),
    auth_ok: cli?.auth_ok ?? null,
    exhausted_until: cli?.exhausted_until ?? null,
    enabled: cli?.enabled ?? true,
    plan: cli?.plan ?? null,
    updated_at: updatedAt,
    source,
  }
}

/** Stale-while-revalidate: a good result is served at once, refreshed in the background past `MEMO_MS`. */
function swr<T>(options: { load: () => Promise<T | null>; empty: T | null; onFail?: () => void; now: () => number }) {
  let lastGood: T | null = null
  let lastAttempt = 0
  let inflight: Promise<T | null> | null = null
  let failing = false

  const refresh = (): Promise<T | null> => {
    if (inflight) return inflight
    lastAttempt = options.now()
    const run = (async () => {
      const value = await options.load()
      lastAttempt = options.now()
      if (value !== null) {
        failing = false
        lastGood = value
      } else if (!failing) {
        failing = true
        options.onFail?.()
      }
      return value
    })().finally(() => {
      inflight = null
    })
    inflight = run
    return run
  }

  return {
    async read(): Promise<T | null> {
      if (lastGood !== null) {
        if (options.now() - lastAttempt >= MEMO_MS) void refresh()
        return lastGood
      }
      // a cold failure inside the memo window does not hammer the CLI
      if (!inflight && options.now() - lastAttempt < MEMO_MS && lastAttempt !== 0) return options.empty
      return (await refresh()) ?? options.empty
    },
    /** The last good value without refreshing. */
    peek: () => lastGood,
    settled: async () => {
      await inflight
    },
  }
}

export interface QuotaOptions {
  cli: AccountCli
  now?: () => number
  warn?: (message: string) => void
}

export interface Quota {
  /** Records a statusline report for `account`; null when the account is new and the distinct accounts are at the cap. */
  record(account: string, usage: Omit<PostedUsage, 'updated_at'>): PostedUsage | null
  /** The last report for `account`, exactly as `agw quota` answers it under `data`. */
  posted(account: string): PostedUsage | null
  /** Every known account (the CLI registry and the reported ids), keyed by id. Disabled ones included. */
  accounts(): Promise<Record<string, AccountQuota>>
  /** Every lane's picked account, display only. A lane that fails keeps its last pick. */
  picks(): Promise<LanePicks>
  /** Resolves when no background refresh is in flight (tests). */
  settled(): Promise<void>
}

export function createQuota(options: QuotaOptions): Quota {
  const now = options.now ?? Date.now
  const posted = new Map<string, PostedUsage>()

  const usage = swr<CliUsage>({
    now,
    empty: null,
    load: async () => {
      const out = await options.cli(['usage', '--json'])
      return out ? parseClaudeUsage(out.stdout, now()) : null
    },
    onFail: () =>
      options.warn?.(
        'claude-account usage --json failed or returned garbage; serving the last good or reported values',
      ),
  })

  let lastPicks: LanePicks | null = null
  const lanes = swr<LanePicks>({
    now,
    empty: {},
    load: async () => {
      const results = await Promise.all(
        LANE_PICKS.map(async (lane) => {
          const out = await options.cli(['pick', '--lane', lane, '--dry', '--why'])
          return out ? parseAccountPickWhy(out.stdout, out.exitCode) : null
        }),
      )
      // A lane whose fresh pick failed keeps its previous entry; a total failure never overwrites the last batch with {}.
      const picks: LanePicks = Object.fromEntries(
        LANE_PICKS.flatMap((lane, i) => {
          const pick = results[i] ?? lastPicks?.[lane]
          return pick ? [[lane, pick] as const] : []
        }),
      )
      lastPicks = picks
      return picks
    },
  })

  return {
    record(account, body) {
      // A report is memory the caller grows: a new id is allowed up to the registry's accounts plus a little slack, a
      // registry account or one already reported always.
      const registry = usage.peek()?.accounts.map((a) => a.id) ?? []
      if (!posted.has(account) && !registry.includes(account)) {
        if (new Set([...registry, ...posted.keys()]).size >= registry.length + ACCOUNT_SLACK) return null
      }
      const entry = { ...body, updated_at: now() }
      posted.set(account, entry)
      return entry
    },
    posted: (account) => posted.get(account) ?? null,
    async accounts() {
      const cli = await usage.read()
      const at = now()
      const ids = new Set<string>([...(cli?.accounts.map((a) => a.id) ?? []), ...posted.keys()])
      const out: Record<string, AccountQuota> = {}
      for (const id of ids) {
        out[id] = mergeAccountQuota(
          cli?.accounts.find((a) => a.id === id),
          cli?.fetchedAt ?? at,
          posted.get(id) ?? null,
          at,
        )
      }
      return out
    },
    async picks() {
      return (await lanes.read()) ?? {}
    },
    async settled() {
      await Promise.all([usage.settled(), lanes.settled()])
    },
  }
}

/** Width of the account id column, shared by the quota header and the agent rows: the longest enabled id or row account, at least 2. */
export function accountColumnWidth(
  accounts: Record<string, AccountQuota>,
  rowAccounts: Iterable<string | null | undefined>,
): number {
  let width = 2
  for (const [id, q] of Object.entries(accounts)) if (q.enabled) width = Math.max(width, id.length)
  for (const a of rowAccounts) width = Math.max(width, a?.length ?? 0)
  return width
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const hhmm = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function untilLabel(resetsAtS: number | null, now: number): string {
  if (resetsAtS == null) return ''
  const mins = Math.max(0, Math.ceil((resetsAtS * 1000 - now) / 60_000))
  return mins >= 60 ? `↺${Math.floor(mins / 60)}h${pad2(mins % 60)}m` : `↺${mins}m`
}

function weeklyLabel(resetsAtS: number | null): string {
  if (resetsAtS == null) return ''
  const d = new Date(resetsAtS * 1000)
  return `↺${WEEKDAYS[d.getDay()]} ${hhmm(d)}`
}

const pct = (v: number | null): string => (v == null ? '?' : `${Math.round(v)}%`)

/**
 * One line per enabled account: `iu  5h 8% ↺2h31m · 7d 88% ↺Tue 17:00`, plus `exhausted until HH:MM`, `auth!` and
 * `stale` (sample older than 6 h) markers. Empty when no account is enabled. Times are local to the host.
 */
export function renderQuotaHeader(
  accounts: Record<string, AccountQuota>,
  now: number,
  idWidth: number = accountColumnWidth(accounts, []),
): string[] {
  return Object.entries(accounts)
    .filter(([, q]) => q.enabled)
    .map(([id, q]) => {
      const five = `5h ${pct(q.five_hour_pct)} ${untilLabel(q.five_hour_resets_at, now)}`.trimEnd()
      const seven = `7d ${pct(q.seven_day_pct)} ${weeklyLabel(q.seven_day_resets_at)}`.trimEnd()
      let line = `${id.padEnd(idWidth)}  ${five} · ${seven}`
      if (q.exhausted_until != null && q.exhausted_until * 1000 > now) {
        line += ` · exhausted until ${hhmm(new Date(q.exhausted_until * 1000))}`
      }
      if (q.auth_ok === false) line += ' · auth!'
      if (q.updated_at == null || now - q.updated_at > STALE_AFTER_MS) line += ' · stale'
      return line
    })
}
