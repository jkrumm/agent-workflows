import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ACCOUNT_SLACK,
  type AccountCli,
  accountColumnWidth,
  claudeAccountCli,
  createQuota,
  mergeAccountQuota,
  type PostedUsage,
  parseAccountPickWhy,
  parseClaudeUsage,
  renderQuotaHeader,
} from '../src/fleet/quota.ts'
import { type AccountQuota, LANE_PICKS } from '../src/fleet/schema.ts'

const CLI_JSON = JSON.stringify({
  default_account: 'iu',
  extra: true,
  accounts: [
    {
      id: 'iu',
      plan: 'max20x',
      enabled: true,
      five_hour: 10,
      seven_day: 88,
      five_hour_resets_at: 1_800_000_000,
      seven_day_resets_at: 1_800_400_000,
      age_s: 100,
      five_hour_age_s: 100,
      seven_day_age_s: 100,
      source: 'statusline',
      auth_ok: true,
      exhausted_until: null,
      future_field: 1,
    },
    { id: 'me', plan: 'max5x', enabled: false, five_hour: null, seven_day: null },
    { id: 'BAD ID' },
  ],
})

describe('parseClaudeUsage', () => {
  test('good: ignores unknown fields, drops invalid rows', () => {
    const u = parseClaudeUsage(CLI_JSON, 1000)
    expect(u?.accounts.map((a) => a.id)).toEqual(['iu', 'me'])
    expect(u?.fetchedAt).toBe(1000)
    expect(u?.accounts[0]).not.toHaveProperty('future_field')
  })

  test('garbage → null', () => {
    expect(parseClaudeUsage('not json', 0)).toBeNull()
    expect(parseClaudeUsage('{"accounts": 3}', 0)).toBeNull()
    expect(parseClaudeUsage('[]', 0)).toBeNull()
  })
})

const usageOf = (five: number) =>
  JSON.stringify({ accounts: [{ id: 'iu', five_hour: five, five_hour_age_s: 0, age_s: 0 }] })

/** A CLI whose answers a test sets; counts the calls and records the arguments. */
function fakeCli() {
  const state = {
    calls: [] as string[][],
    usage: usageOf(10) as string | null,
    pick: ((_lane: string) => '# picked=me reason=home stale=false') as (lane: string) => string | null,
  }
  const cli: AccountCli = async (args) => {
    state.calls.push(args)
    if (args[0] === 'usage') return state.usage === null ? null : { stdout: state.usage, exitCode: 0 }
    const out = state.pick(args[2] ?? '')
    return out === null ? null : { stdout: `export CLAUDE_CONFIG_DIR='/tmp/x'\n${out}\n`, exitCode: 0 }
  }
  return { state, cli }
}

describe('parseClaudeUsage', () => {
  test('good: ignores unknown fields, drops invalid rows', () => {
    const u = parseClaudeUsage(CLI_JSON, 1000)
    expect(u?.accounts.map((a) => a.id)).toEqual(['iu', 'me'])
    expect(u?.fetchedAt).toBe(1000)
    expect(u?.accounts[0]).not.toHaveProperty('future_field')
  })

  test('garbage → null', () => {
    expect(parseClaudeUsage('not json', 0)).toBeNull()
    expect(parseClaudeUsage('{"accounts": 3}', 0)).toBeNull()
    expect(parseClaudeUsage('[]', 0)).toBeNull()
  })
})

describe('parseAccountPickWhy', () => {
  test('the trailing comment names the pick, on exit 0 and on the spill exit 3', () => {
    expect(parseAccountPickWhy('export X=1\n# picked=me reason=pace stale=true\n', 0)).toEqual({
      picked: 'me',
      reason: 'pace',
      stale: true,
    })
    expect(parseAccountPickWhy('# picked=spill reason=wall stale=false', 3)?.picked).toBe('spill')
  })
  test('any other exit, or no comment, is unavailable', () => {
    expect(parseAccountPickWhy('# picked=me reason=pace stale=true', 1)).toBeNull()
    expect(parseAccountPickWhy('export X=1', 0)).toBeNull()
  })
})

describe('claudeAccountCli (a real script)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-account-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function script(body: string): AccountCli {
    const bin = join(dir, 'claude-account')
    writeFileSync(bin, `#!/bin/sh\n${body}\n`)
    chmodSync(bin, 0o755)
    return claudeAccountCli({ bin, env: { PATH: process.env.PATH, HOME: dir } })
  }

  test('stdout of a good run', async () => {
    expect((await script('echo hi')(['usage', '--json']))?.stdout).toBe('hi\n')
  })
  test("a non-zero exit is null, except the picker's spill exit 3", async () => {
    expect(await script('exit 1')(['usage', '--json'])).toBeNull()
    expect(await script('echo spill; exit 3')(['pick', '--lane', 'wave'])).toEqual({ stdout: 'spill\n', exitCode: 3 })
    expect(await script('exit 3')(['usage', '--json'])).toBeNull()
  })
  test('a missing binary is null, never a throw', async () => {
    expect(await claudeAccountCli({ bin: join(dir, 'nope'), env: {} })(['usage'])).toBeNull()
  })
  test('the child sees only PATH, HOME, TMPDIR and LANG', async () => {
    const out = await script('env | sort | cut -d= -f1')(['x']).then((r) => r?.stdout.split('\n'))
    expect(out).toContain('PATH')
    expect(out).not.toContain('AGW_API_SECRET')
  })
})

describe('createQuota (fake CLI, fake clock)', () => {
  let clock: number
  const now = () => clock
  beforeEach(() => {
    clock = 1_800_000_000_000
  })

  test('good output is parsed and memoized inside the window', async () => {
    const { state, cli } = fakeCli()
    const quota = createQuota({ cli, now })
    expect((await quota.accounts()).iu?.five_hour_pct).toBe(10)
    await quota.accounts()
    expect(state.calls.filter((c) => c[0] === 'usage')).toHaveLength(1)
  })

  test('garbage or a failing CLI: no account, never a throw, and the warning is given once', async () => {
    const { state, cli } = fakeCli()
    const warnings: string[] = []
    state.usage = 'garbage'
    const quota = createQuota({ cli, now, warn: (m) => warnings.push(m) })
    expect(await quota.accounts()).toEqual({})
    clock += 20_000
    await quota.accounts()
    expect(warnings).toHaveLength(1)
  })

  test('stale-while-revalidate: serves the last good at once, refreshes in the background, keeps it on a failed refresh', async () => {
    const { state, cli } = fakeCli()
    const quota = createQuota({ cli, now })
    expect((await quota.accounts()).iu?.five_hour_pct).toBe(10)

    state.usage = usageOf(20)
    clock += 16_000
    expect((await quota.accounts()).iu?.five_hour_pct).toBe(10) // stale, immediate
    await quota.settled()
    expect((await quota.accounts()).iu?.five_hour_pct).toBe(20)

    state.usage = null
    clock += 16_000
    await quota.accounts()
    await quota.settled()
    expect((await quota.accounts()).iu?.five_hour_pct).toBe(20)
  })

  test('CLI down: a reported figure still produces an account', async () => {
    const { state, cli } = fakeCli()
    state.usage = null
    const quota = createQuota({ cli, now })
    quota.record('me', { five_hour_pct: 4, five_hour_mins_left: 30, seven_day_pct: 9 })
    const q = await quota.accounts()
    expect(q.me?.five_hour_pct).toBe(4)
    expect(q.me?.source).toBe('post')
    expect(quota.posted('me')).toEqual({
      five_hour_pct: 4,
      five_hour_mins_left: 30,
      seven_day_pct: 9,
      updated_at: clock,
    })
    expect(quota.posted('iu')).toBeNull()
  })

  test('all 6 lanes come back from one batch; a second call inside the memo window spawns nothing more', async () => {
    const { state, cli } = fakeCli()
    const quota = createQuota({ cli, now })
    const picks = await quota.picks()
    expect(Object.keys(picks).toSorted()).toEqual([...LANE_PICKS].toSorted())
    expect(picks.wave).toEqual({ picked: 'me', reason: 'home', stale: false })
    expect(state.calls.filter((c) => c[0] === 'pick')).toHaveLength(LANE_PICKS.length)
    await quota.picks()
    expect(state.calls.filter((c) => c[0] === 'pick')).toHaveLength(LANE_PICKS.length)
    expect(state.calls.find((c) => c[0] === 'pick')).toEqual(['pick', '--lane', 'interactive', '--dry', '--why'])
  })

  test('a failing CLI at cold start is {}, never a throw', async () => {
    const { state, cli } = fakeCli()
    state.pick = () => null
    expect(await createQuota({ cli, now }).picks()).toEqual({})
  })

  test('partial failure: the failing lane keeps its previous pick, the others move on', async () => {
    const { state, cli } = fakeCli()
    const quota = createQuota({ cli, now })
    state.pick = () => '# picked=p1 reason=home stale=false'
    const first = await quota.picks()
    expect(first.wave?.picked).toBe('p1')

    state.pick = (lane) => (lane === 'wave' ? null : '# picked=p2 reason=home stale=false')
    clock += 16_000
    await quota.picks()
    await quota.settled()
    const after = await quota.picks()
    expect(after.wave).toEqual(first.wave)
    expect(after.fan?.picked).toBe('p2')
  })

  test('SWR: a stale read returns the previous picks at once and one refresh runs for concurrent callers', async () => {
    const { state, cli } = fakeCli()
    const quota = createQuota({ cli, now })
    const first = await quota.picks()
    clock += 16_000
    const [a, b] = await Promise.all([quota.picks(), quota.picks()])
    expect(a).toBe(first)
    expect(b).toBe(first)
    await quota.settled()
    expect(state.calls.filter((c) => c[0] === 'pick')).toHaveLength(LANE_PICKS.length * 2)
  })
})

describe('reported accounts are capped', () => {
  test("new ids are accepted up to the registry's accounts plus the slack, known ones always", async () => {
    const { cli } = fakeCli() // the registry has one account: iu
    const quota = createQuota({ cli })
    await quota.accounts()
    const report = { five_hour_pct: 1, five_hour_mins_left: null, seven_day_pct: null }
    for (let i = 0; i < ACCOUNT_SLACK; i++) expect(quota.record(`x${i}`, report)).not.toBeNull()
    expect(quota.record('one-too-many', report)).toBeNull()
    expect(quota.record('x0', { ...report, five_hour_pct: 2 })?.five_hour_pct).toBe(2) // a reported id still updates
    expect(quota.record('iu', report)).not.toBeNull() // a registry account is never refused
  })
})

describe('mergeAccountQuota — POST precedence per window', () => {
  const NOW = 1_800_000_000_000
  const cli = parseClaudeUsage(CLI_JSON, NOW)!.accounts[0]! // sample 100 s old
  const post = (ageMs: number, extra: Partial<Omit<PostedUsage, 'updated_at'>> = {}) => ({
    five_hour_pct: 50,
    five_hour_mins_left: 60,
    seven_day_pct: 91,
    updated_at: NOW - ageMs,
    ...extra,
  })

  test('newer POST wins both windows', () => {
    const q = mergeAccountQuota(cli, NOW, post(10_000), NOW)
    expect(q.five_hour_pct).toBe(50)
    expect(q.seven_day_pct).toBe(91)
    expect(q.five_hour_mins_left).toBe(60)
    expect(q.source).toBe('post')
  })

  test('older POST loses', () => {
    const q = mergeAccountQuota(cli, NOW, post(500_000), NOW)
    expect(q.five_hour_pct).toBe(10)
    expect(q.seven_day_pct).toBe(88)
    expect(q.source).toBe('statusline')
  })

  test('window-wise: newer on 5h only', () => {
    const c = { ...cli, five_hour_age_s: 1000, seven_day_age_s: 5 }
    const q = mergeAccountQuota(c, NOW, post(60_000), NOW)
    expect(q.five_hour_pct).toBe(50)
    expect(q.seven_day_pct).toBe(88)
  })

  test('newer POST with null mins_left keeps the CLI 5h reset', () => {
    const q = mergeAccountQuota(cli, NOW, post(10_000, { five_hour_mins_left: null }), NOW)
    expect(q.five_hour_pct).toBe(50)
    expect(q.five_hour_resets_at).toBe(1_800_000_000)
    expect(q.five_hour_mins_left).toBe(Math.ceil((1_800_000_000 * 1000 - NOW) / 60_000))
  })

  test('POST with null seven_day keeps the CLI value', () => {
    const q = mergeAccountQuota(cli, NOW, post(1000, { seven_day_pct: null }), NOW)
    expect(q.seven_day_pct).toBe(88)
  })

  test('no CLI row: POST only, enabled defaults true', () => {
    const q = mergeAccountQuota(undefined, NOW, post(1000), NOW)
    expect(q.enabled).toBe(true)
    expect(q.plan).toBeNull()
  })
})

describe('renderQuotaHeader', () => {
  const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime()
  const base: AccountQuota = {
    five_hour_pct: 8,
    seven_day_pct: 88,
    five_hour_resets_at: Math.floor(NOW / 1000) + 2 * 3600 + 31 * 60,
    seven_day_resets_at: Math.floor(new Date(2026, 9, 27, 17, 0, 0).getTime() / 1000),
    five_hour_mins_left: 151,
    auth_ok: true,
    exhausted_until: null,
    enabled: true,
    plan: 'max20x',
    updated_at: NOW - 60_000,
    source: 'statusline',
  }

  test('plain line, disabled accounts skipped', () => {
    const lines = renderQuotaHeader({ iu: base, me: { ...base, enabled: false } }, NOW)
    expect(lines).toEqual(['iu  5h 8% ↺2h31m · 7d 88% ↺Tue 17:00'])
  })

  test('exhausted / auth! / stale markers', () => {
    const until = Math.floor(new Date(2026, 9, 24, 14, 5, 0).getTime() / 1000)
    const [line] = renderQuotaHeader(
      {
        me: {
          ...base,
          exhausted_until: until,
          auth_ok: false,
          updated_at: NOW - 7 * 3600 * 1000,
        },
      },
      NOW,
    )
    expect(line).toContain('· exhausted until 14:05')
    expect(line).toContain('· auth!')
    expect(line).toEndWith('· stale')
  })

  test('past exhausted_until is not shown; unknown pct is ?', () => {
    const [line] = renderQuotaHeader(
      {
        iu: {
          ...base,
          five_hour_pct: null,
          five_hour_resets_at: null,
          exhausted_until: Math.floor(NOW / 1000) - 10,
        },
      },
      NOW,
    )
    expect(line).not.toContain('exhausted')
    expect(line).toContain('5h ? · 7d')
  })

  test('ids are aligned', () => {
    const lines = renderQuotaHeader({ iu: base, work: base }, NOW)
    expect(lines[0]!.startsWith('iu    5h')).toBe(true)
  })
})

describe('accountColumnWidth', () => {
  const q = (enabled = true) => ({ enabled }) as AccountQuota
  test('min 2, longest enabled id or row account', () => {
    expect(accountColumnWidth({ a: q() }, [])).toBe(2)
    expect(accountColumnWidth({ work: q(), longname: q(false) }, ['?'])).toBe(4)
    expect(accountColumnWidth({ iu: q() }, ['research'])).toBe(8)
  })
})
