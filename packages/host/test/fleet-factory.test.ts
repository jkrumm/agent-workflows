import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { deriveState, mapFleet } from '../src/fleet/derive.ts'
import {
  commandRunner,
  type CommandResult,
  type FactoryFleet,
  type FactoryRead,
  type FactorySession,
  fleetConfig,
  readFactoryFleet,
  type RunCommand,
} from '../src/fleet/factory.ts'
import { createFleet } from '../src/fleet/index.ts'
import { createQuota } from '../src/fleet/quota.ts'
import { OVERVIEW_PAYLOAD } from '../src/fleet/schema.ts'

// The agents overview is a client of the factory's /v1 read API: `factory read overview` and `factory read sessions --live` mapped onto the snapshot.
// Fixtures are invented by hand; the factory is a fake runner or a fake script, never a real server.

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function session(overrides: Partial<FactorySession> = {}): FactorySession {
  return {
    id: 'sess-1',
    state: 'working',
    hc: 'working',
    wait: null,
    account: 'iu',
    terminal: 't7',
    plan: null,
    wave: null,
    title: 'some task',
    headline: null,
    since: iso(2 * HOUR_MS),
    lastActivityAt: iso(60_000),
    ...overrides,
  }
}

function fleet(overrides: Partial<FactoryFleet> = {}): FactoryFleet {
  return { asks: [], repos: [], unplaced: [], errors: [], ...overrides }
}

const repo = (name: string, sessions: FactorySession[], git: FactoryFleet['repos'][number]['git'] = null) => ({
  name,
  space: `/work/${name}`,
  git,
  sessions,
})

const map = (f: FactoryFleet, staleAfterHours = 24) => mapFleet(f, { now: NOW, staleAfterHours })

describe('agent state from the factory session', () => {
  const derive = (s: Partial<FactorySession>, lastActivityMsAgo = 60_000) =>
    deriveState({ session: session(s), lastActivityAt: NOW - lastActivityMsAgo, now: NOW, staleAfterMs: 24 * HOUR_MS })

  test.each([
    ['waiting', 'needs_you'],
    ['blocked', 'needs_you'],
    ['walled', 'needs_you'],
    ['stuck', 'needs_you'],
    ['working', 'working'],
    ['starting', 'working'],
    ['idle', 'idle'],
  ] as const)('state %s is %s', (state, expected) => {
    expect(derive({ state, hc: null })).toBe(expected)
  })

  test('a state the factory adds is unknown: that one row degrades, never the fleet', () => {
    expect(derive({ state: 'hibernating', hc: null })).toBe('unknown')
    expect(derive({ state: 'hibernating', hc: 'blocked' })).toBe('needs_you') // hc's own word still counts
  })

  test('hc done is done; hc blocked needs the owner even when the factory says idle', () => {
    expect(derive({ state: 'idle', hc: 'done' })).toBe('done')
    expect(derive({ state: 'idle', hc: 'blocked' })).toBe('needs_you')
  })

  test('a wait on workers or a deploy is the machines, not the owner', () => {
    expect(derive({ state: 'waiting', hc: 'done', wait: 'workers' })).toBe('done')
    expect(derive({ state: 'waiting', hc: 'idle', wait: 'deploy' })).toBe('idle')
    expect(derive({ state: 'waiting', hc: 'idle', wait: 'owner' })).toBe('needs_you')
  })

  test('hc blocked wins over a managed wait: a terminal stuck on a permission prompt needs the owner', () => {
    expect(derive({ state: 'waiting', hc: 'blocked', wait: 'workers' })).toBe('needs_you')
    expect(derive({ state: 'waiting', hc: 'blocked', wait: 'deploy' })).toBe('needs_you')
  })

  test('idle and done go stale past the threshold; working never does', () => {
    expect(derive({ state: 'idle', hc: 'idle' }, 25 * HOUR_MS)).toBe('stale')
    expect(derive({ state: 'idle', hc: 'done' }, 25 * HOUR_MS)).toBe('stale')
    expect(derive({ state: 'idle', hc: 'idle' }, 24 * HOUR_MS)).toBe('idle') // the boundary is exclusive
    expect(derive({ state: 'working', hc: 'working' }, 48 * HOUR_MS)).toBe('working')
    expect(derive({ state: 'blocked', hc: 'blocked' }, 48 * HOUR_MS)).toBe('needs_you')
  })

  test('no activity time is never stale', () => {
    expect(
      deriveState({ session: session({ state: 'idle' }), lastActivityAt: null, now: NOW, staleAfterMs: HOUR_MS }),
    ).toBe('idle')
  })

  test('the threshold is the caller’s: 48 h keeps a day-old idle session idle', () => {
    const f = fleet({ repos: [repo('p', [session({ state: 'idle', hc: 'idle', lastActivityAt: iso(30 * HOUR_MS) })])] })
    expect(map(f, 24).projects[0]?.agents[0]?.state).toBe('stale')
    expect(map(f, 48).projects[0]?.agents[0]?.state).toBe('idle')
  })
})

describe('mapFleet', () => {
  test('a session becomes an agent: id, terminal, title, account, headline, times, plan', () => {
    const f = fleet({
      repos: [
        repo('alpha', [
          session({
            id: 'abc',
            terminal: 'mini/t3',
            title: '✳ Fix the thing',
            headline: 'Tests pass, waiting for review',
            plan: '/work/alpha/docs/waves/PLAN.md',
            wave: 2,
            wait: 'owner',
            state: 'waiting',
            hc: 'blocked',
          }),
        ]),
      ],
    })
    expect(map(f).projects[0]?.agents[0]).toEqual({
      id: 'abc',
      source: 'factory',
      sessionId: 'abc',
      paneId: 'mini/t3',
      workspaceId: null,
      title: 'Fix the thing',
      state: 'needs_you',
      herdrStatus: 'blocked',
      claudeStatus: null,
      waitingFor: 'owner',
      lastPrompt: null,
      lastReply: 'Tests pass, waiting for review',
      lastActivityAt: NOW - 60_000,
      account: 'iu',
      startedAt: NOW - 2 * HOUR_MS,
      plan: '/work/alpha/docs/waves/PLAN.md',
      wave: 2,
    })
  })

  test('the generic banner title and an unknown hc word are nulled', () => {
    const a = map(fleet({ repos: [repo('p', [session({ title: '✳ Claude Code', hc: 'weird' })])] })).projects[0]
      ?.agents[0]
    expect(a?.title).toBeNull()
    expect(a?.herdrStatus).toBe('unknown')
    const b = map(fleet({ repos: [repo('p', [session({ hc: null })])] })).projects[0]?.agents[0]
    expect(b?.herdrStatus).toBeNull()
  })

  test('a repo is a project with its git; ahead and behind are 0; a repo with no session is not listed', () => {
    const commit = { sha: 'a1b2c3d', subject: 'feat: x', at: '2026-11-02T10:00:00.000Z' }
    const snap = map(
      fleet({
        repos: [
          repo('alpha', [session()], { branch: 'master', dirty: true, lastCommit: commit }),
          repo('quiet', []),
          repo('detached', [session({ id: 'd1' })], { branch: null, dirty: true, lastCommit: commit }),
        ],
      }),
    )
    expect(snap.projects.map((p) => p.name).toSorted()).toEqual(['alpha', 'detached'])
    expect(snap.projects.find((p) => p.name === 'alpha')).toMatchObject({
      cwd: '/work/alpha',
      git: { branch: 'master', dirty: true, ahead: 0, behind: 0, lastCommit: commit },
    })
    expect(snap.projects.find((p) => p.name === 'detached')?.git).toBeNull() // no branch, no git status to report
  })

  test('unplaced sessions form an "unplaced" project with no directory', () => {
    const snap = map(fleet({ unplaced: [session({ id: 'u1', terminal: 't9' })] }))
    expect(snap.projects).toEqual([
      expect.objectContaining({
        name: 'unplaced',
        cwd: '',
        git: null,
        agents: [expect.objectContaining({ id: 'u1' })],
      }),
    ])
    expect(map(fleet()).projects).toEqual([])
  })

  test('projects and agents are urgency-sorted, the summary counts the states', () => {
    const snap = map(
      fleet({
        repos: [
          repo('b-idle', [session({ id: 'i', state: 'idle', hc: 'idle' })]),
          repo('a-work', [session({ id: 'w' })]),
          repo('c-mixed', [
            session({ id: 'm-idle', state: 'idle', hc: 'idle' }),
            session({ id: 'm-block', state: 'blocked', hc: 'blocked' }),
          ]),
          repo('d-old', [session({ id: 'o', state: 'idle', hc: 'done', lastActivityAt: iso(40 * HOUR_MS) })]),
        ],
      }),
    )
    expect(snap.projects.map((p) => p.name)).toEqual(['c-mixed', 'a-work', 'b-idle', 'd-old'])
    expect(snap.projects[0]?.agents.map((a) => a.id)).toEqual(['m-block', 'm-idle'])
    expect(snap.summary).toEqual({ needsYou: 1, working: 1, idle: 2, stale: 1, done: 0 })
  })

  test('an id seen twice is one agent; an id cleaning would change is dropped', () => {
    const snap = map(
      fleet({
        repos: [repo('a', [session({ id: 'dup' }), session({ id: 'bad\nid' })]), repo('b', [session({ id: 'dup' })])],
      }),
    )
    expect(snap.projects.flatMap((p) => p.agents.map((a) => a.id))).toEqual(['dup'])
  })

  test('sessions dropped for an unsafe or a duplicate id are counted, one warning per kind', () => {
    const snap = map(
      fleet({
        repos: [
          repo('a', [session({ id: 'dup' }), session({ id: 'bad\nid' }), session({ id: 'bad2\tid' })]),
          repo('b', [session({ id: 'dup' }), session({ id: 'dup' })]),
        ],
      }),
    )
    expect(snap.warnings).toEqual([
      '2 factory session(s) skipped: id is not a clean single line',
      '2 factory session(s) skipped: duplicate session id',
    ])
    expect(map(fleet({ repos: [repo('a', [session()])] })).warnings).toEqual([])
  })

  test('one session in a state the factory added is one unknown agent beside the others', () => {
    const snap = map(
      fleet({ repos: [repo('p', [session({ id: 'new', state: 'hibernating' }), session({ id: 'old' })])] }),
    )
    expect(snap.projects[0]?.agents.map((a) => [a.id, a.state])).toEqual([
      ['old', 'working'],
      ['new', 'unknown'],
    ])
    expect(snap.summary).toEqual({ needsYou: 0, working: 1, idle: 0, stale: 0, done: 0 })
  })

  test('human asks become the human queue, newest first; other kinds do not', () => {
    const snap = map(
      fleet({
        asks: [
          { id: 'hc:1', kind: 'human', text: 'sign the thing', at: '2026-11-01T00:00:00.000Z' },
          { id: 'f:2', kind: 'blocker', text: 'build is red', at: '2026-11-02T00:00:00.000Z' },
          { id: 'hc:3', kind: 'human', text: 'approve\x1b[31m this', at: '2026-11-02T00:00:00.000Z' },
        ],
      }),
    )
    expect(snap.humanQueue).toEqual([
      { id: 'hc:3', askedAt: '2026-11-02T00:00:00.000Z', question: 'approve[31m this', cmd: null },
      { id: 'hc:1', askedAt: '2026-11-01T00:00:00.000Z', question: 'sign the thing', cmd: null },
    ])
  })

  test('the factory’s errors are warnings; text from outside loses its control bytes', () => {
    const snap = map(
      fleet({
        errors: ['git: repo x did not answer'],
        repos: [repo('p', [session({ headline: 'line\x1b[2Jone', title: 'ti\ntle' })])],
      }),
    )
    expect(snap.warnings).toEqual(['git: repo x did not answer'])
    expect(snap.projects[0]?.agents[0]).toMatchObject({ lastReply: 'line[2Jone', title: 'ti tle' })
  })
})

// ── the reader ───────────────────────────────────────────────────────────────

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  ...over,
})

/** A fake runner: answers per subcommand (`overview` / `sessions`), records every call. */
const fakeRun = (answers: { overview?: CommandResult; sessions?: CommandResult } | CommandResult) => {
  const calls: { cmd: string[]; extraEnv?: Record<string, string>; timeoutMs?: number }[] = []
  const run: RunCommand = async (cmd, options) => {
    calls.push({ cmd, ...options })
    if ('stdout' in answers) return answers
    return (cmd[2] === 'overview' ? answers.overview : answers.sessions) ?? result({ stdout: '{}' })
  }
  return { run, calls }
}

const config = { factoryBin: 'factory' }

/** A /v1 session card with the fields agw reads and a few it does not. */
const card = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  issue: 12,
  role: 'worker',
  title: 'some task',
  summary: 'doing it',
  state: 'working',
  wait: null,
  account: 'iu',
  terminal: { id: 't7', name: 'w', space: '/work/alpha', tab: null, workspace: null },
  repo: '/work/alpha',
  since: '2026-11-03T10:00:00.000Z',
  lastActivityAt: '2026-11-03T11:59:00.000Z',
  futureField: 1,
  ...over,
})
const ask = (over: Record<string, unknown> = {}) => ({
  id: 'queue:1',
  kind: 'human',
  repo: null,
  session: null,
  short: 'x',
  text: 'decide this',
  source: 'queue',
  at: '2026-11-03T09:00:00.000Z',
  summary: 's',
  stale: false,
  ...over,
})
const answers = (cards: unknown[], overview: Record<string, unknown> = {}) => ({
  overview: result({ stdout: JSON.stringify({ version: 'v1', asks: [], humanQueue: [], health: [], ...overview }) }),
  sessions: result({ stdout: JSON.stringify({ sessions: cards }) }),
})
const readWith = (a: Parameters<typeof fakeRun>[0], limits = {}) => readFactoryFleet(fakeRun(a).run, config, {}, limits)
const warning = (read: FactoryRead) => (read.ok ? null : read.warning)

describe('readFactoryFleet', () => {
  test('runs the two /v1 reads in parallel with the token only, and maps the answers', async () => {
    const { run, calls } = fakeRun(answers([card()]))
    const read = await readFactoryFleet(run, config, {
      FACTORY_TOKEN: 'tok',
      FACTORY_URL: 'http://f.test',
      AGW_API_SECRET: 's',
    })
    expect(calls.map((c) => c.cmd)).toEqual([
      ['factory', 'read', 'overview', '--format', 'json'],
      ['factory', 'read', 'sessions', '--live', '--format', 'json'],
    ])
    for (const c of calls) {
      expect(c.extraEnv).toEqual({ FACTORY_TOKEN: 'tok', FACTORY_URL: 'http://f.test' }) // never the host's other secrets
      expect(c.timeoutMs).toBe(10_000)
    }
    expect(read).toEqual({
      ok: true,
      fleet: {
        asks: [],
        repos: [
          {
            name: 'alpha',
            space: '/work/alpha',
            git: null,
            sessions: [
              {
                id: 'sess-1',
                state: 'working',
                hc: null,
                wait: null,
                account: 'iu',
                terminal: 't7',
                plan: null,
                wave: null,
                title: 'some task',
                headline: 'doing it',
                since: '2026-11-03T10:00:00.000Z',
                lastActivityAt: '2026-11-03T11:59:00.000Z',
              },
            ],
          },
        ],
        unplaced: [],
        errors: [],
      },
    })
  })

  test('a worktree session falls under its repo’s space; sessions of one space share a project', async () => {
    const read = await readWith(
      answers([
        card({ id: 'a' }),
        card({
          id: 'b',
          repo: '/work/alpha/.claude/worktrees/x-1',
          terminal: { id: 't8', name: null, space: '/work/alpha', tab: null, workspace: null },
        }),
        card({ id: 'c', repo: '/work/beta', terminal: null }),
      ]),
    )
    expect(read.ok).toBe(true)
    const repos = read.ok ? read.fleet.repos : []
    expect(repos.map((r) => [r.name, r.space, r.sessions.map((s) => s.id)])).toEqual([
      ['alpha', '/work/alpha', ['a', 'b']],
      ['beta', '/work/beta', ['c']],
    ])
  })

  test('a session with neither repo nor space is unplaced', async () => {
    const read = await readWith(answers([card({ id: 'u', repo: null, terminal: null })]))
    expect(read.ok && read.fleet.repos).toEqual([])
    expect(read.ok && read.fleet.unplaced.map((s) => s.id)).toEqual(['u'])
  })

  test('the asks and the human queue become asks; nothing else of them is kept', async () => {
    const read = await readWith(
      answers([], {
        asks: [ask({ id: 'wait:1', kind: 'decision', text: 'pick' })],
        humanQueue: [ask({ id: 'queue:2', text: 'owner call' })],
      }),
    )
    expect(read.ok && read.fleet.asks).toEqual([
      { id: 'wait:1', kind: 'decision', text: 'pick', at: '2026-11-03T09:00:00.000Z' },
      { id: 'queue:2', kind: 'human', text: 'owner call', at: '2026-11-03T09:00:00.000Z' },
    ])
  })

  test('the mapped fleet derives like any other: a blocked card needs the owner, human asks queue up', async () => {
    const read = await readWith(answers([card({ state: 'blocked' })], { humanQueue: [ask({ text: 'owner call' })] }))
    if (!read.ok) throw new Error(read.warning)
    const snapshot = map(read.fleet)
    expect(snapshot.projects[0]?.agents[0]?.state).toBe('needs_you')
    expect(snapshot.humanQueue.map((q) => q.question)).toEqual(['owner call'])
  })

  test('a state the factory adds does not fail the parse', async () => {
    expect((await readWith(answers([card({ state: 'hibernating' })]))).ok).toBe(true)
  })

  test('the stderr line of a failure is one clean line of at most 300 characters', async () => {
    const read = await readWith(result({ exitCode: 1, stderr: `\n  boom\x1b[31m ${'x'.repeat(1000)}\nsecond line` }))
    const text = warning(read) ?? ''
    expect(text.startsWith('factory read overview failed (exit 1): boom[31m xxx')).toBe(true)
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('second line')
    expect(text.length).toBeLessThan(380)
  })

  test('exit code and the first line of stderr name the cause', async () => {
    const read = await readWith(result({ exitCode: 3, stderr: 'FACTORY_TOKEN is not set\nusage: factory …' }))
    expect(read).toEqual({ ok: false, warning: 'factory read overview failed (exit 3): FACTORY_TOKEN is not set' })
  })

  test('one call failing fails the read, naming that call', async () => {
    const down = result({ exitCode: 2, stderr: 'no sessions' })
    expect(warning(await readWith({ ...answers([]), sessions: down }))).toBe(
      'factory read sessions --live failed (exit 2): no sessions',
    )
    expect(warning(await readWith({ ...answers([]), overview: down }))).toBe(
      'factory read overview failed (exit 2): no sessions',
    )
  })

  test('a non-zero exit without stderr, a timeout, a spawn error, bad JSON and a wrong shape are each a warning', async () => {
    const warn = async (answer: CommandResult) => warning(await readWith(answer))
    expect(await warn(result({ exitCode: 1 }))).toBe('factory read overview failed (exit 1)')
    expect(await warn(result({ exitCode: null, timedOut: true }))).toBe(
      'factory read overview failed: timed out after 10 s',
    )
    expect(await warn(result({ exitCode: null, error: 'Error: ENOENT: no such file' }))).toBe(
      'factory read overview failed: Error: ENOENT: no such file',
    )
    expect(await warn(result({ stdout: 'not json' }))).toBe('factory read overview failed: output is not JSON')
    expect(await warn(result({ stdout: JSON.stringify({ asks: [{ id: 1 }] }) }))).toBe(
      'factory read overview failed: unexpected shape at asks.0.id',
    )
    // `{}` is no session list
    expect(warning(await readWith({ overview: result({ stdout: '{}' }), sessions: result({ stdout: '{}' }) }))).toBe(
      'factory read sessions --live failed: unexpected shape at sessions',
    )
    expect(
      warning(await readWith({ ...answers([]), sessions: result({ stdout: JSON.stringify({ sessions: [{}] }) }) })),
    ).toBe('factory read sessions --live failed: unexpected shape at sessions.0.id')
  })
})

describe('the real runner and a fake `factory` script', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-factory-'))
    env = { PATH: process.env.PATH, HOME: dir, AGW_API_SECRET: 'host-secret', FACTORY_TOKEN: 'tok' }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const script = (body: string) => {
    const path = join(dir, 'factory')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  let env: Record<string, string | undefined>

  test('the child sees the token and its arguments, and none of the host’s secrets', async () => {
    const bin = script(
      `case "$2" in
  overview) echo "{\\"asks\\":[{\\"id\\":\\"a\\",\\"kind\\":\\"k\\",\\"at\\":\\"t\\",\\"text\\":\\"args=$* token=$FACTORY_TOKEN secret=\${AGW_API_SECRET:-none}\\"}]}" ;;
  *) echo '{"sessions":[{"id":"u","state":"idle"}]}' ;;
esac`,
    )
    const read = await readFactoryFleet(commandRunner(env), { factoryBin: bin }, env)
    expect(read).toMatchObject({
      ok: true,
      fleet: {
        asks: [{ text: 'args=read overview --format json token=tok secret=none' }],
        unplaced: [{ id: 'u', state: 'idle' }],
      },
    })
  })

  test('a failing script is the exit code and its first stderr line', async () => {
    const bin = script('echo "FACTORY_TOKEN is not set" >&2; exit 3')
    expect(await readFactoryFleet(commandRunner(env), { factoryBin: bin }, {})).toEqual({
      ok: false,
      warning: 'factory read overview failed (exit 3): FACTORY_TOKEN is not set',
    })
  })

  test('stdout is counted per chunk against a byte budget: a runaway child is killed, never buffered whole', async () => {
    // `yes` prints forever; without the kill this read never ends
    const read = await readFactoryFleet(commandRunner(env), { factoryBin: script('exec yes') }, env, {
      maxBytes: 64 * 1024,
    })
    expect(read).toEqual({ ok: false, warning: 'factory read overview failed: output over the size limit' })
    // output within the budget is read whole, multi-byte text included
    const bin = script(`printf '{"sessions":[{"id":"é","state":"idle"}]}'`)
    expect(await readFactoryFleet(commandRunner(env), { factoryBin: bin }, env, { maxBytes: 1024 })).toMatchObject({
      ok: true,
      fleet: { unplaced: [{ id: 'é' }] },
    })
  })

  test('stderr is capped too: a child that floods it is killed and the capped diagnostic stays', async () => {
    const bin = script('echo "FACTORY_TOKEN is not set" >&2; exec yes err >&2')
    const read = await readFactoryFleet(commandRunner(env), { factoryBin: bin }, env)
    expect(read.ok).toBe(false)
    const warning = !read.ok ? read.warning : ''
    expect(warning).toContain('FACTORY_TOKEN is not set') // the first line survived the cap
    expect(warning.length).toBeLessThan(340)
  })

  test('a missing binary and a hung one are warnings, the hung one killed at the timeout', async () => {
    const missing = await readFactoryFleet(commandRunner(env), { factoryBin: join(dir, 'nope') }, env)
    expect(missing).toMatchObject({ ok: false, warning: expect.stringContaining('factory read overview failed') })
    const hung = await readFactoryFleet(commandRunner(env), { factoryBin: script('sleep 30') }, env, { timeoutMs: 200 })
    expect(hung).toEqual({ ok: false, warning: 'factory read overview failed: timed out after 0 s' })
  })
})

describe('fleetConfig', () => {
  test('AGW_FACTORY_BIN overrides; else the CLI on PATH; the stale threshold defaults to 24 h', () => {
    expect(fleetConfig({}, '/nonexistent')).toEqual({ factoryBin: 'factory', staleAfterHours: 24 })
    expect(fleetConfig({ AGW_FACTORY_BIN: ' /opt/factory ', AGW_AGENT_STALE_HOURS: '48' }, '/nonexistent')).toEqual({
      factoryBin: '/opt/factory',
      staleAfterHours: 48,
    })
    expect(fleetConfig({ AGW_AGENT_STALE_HOURS: 'x' }, '/nonexistent').staleAfterHours).toBe(24)
  })
})

// ── the fleet: cache, failure, payload ───────────────────────────────────────

const quota = () =>
  createQuota({
    cli: async (args) =>
      args[0] === 'usage'
        ? { stdout: JSON.stringify({ accounts: [{ id: 'iu', five_hour: 5, seven_day: 6, age_s: 1 }] }), exitCode: 0 }
        : { stdout: '# picked=iu reason=home stale=false\n', exitCode: 0 },
  })

function setupFleet(reads: FactoryRead[]) {
  let clock = NOW
  let calls = 0
  const instance = createFleet({
    factory: async () => reads[Math.min(calls++, reads.length - 1)] as FactoryRead,
    quota: quota(),
    latestOverview: async () => null,
    config: { staleAfterHours: 24 },
    now: () => clock,
  })
  return { fleet: instance, advance: (ms: number) => (clock += ms), calls: () => calls }
}

const ok = (f: FactoryFleet): FactoryRead => ({ ok: true, fleet: f })

describe('createFleet over the factory', () => {
  test('the snapshot is cached for 45 s, `fresh` and a stale override read again', async () => {
    const s = setupFleet([ok(fleet({ repos: [repo('p', [session()])] }))])
    await s.fleet.snapshot()
    await s.fleet.snapshot()
    expect(s.calls()).toBe(1)
    s.advance(44_000)
    await s.fleet.snapshot()
    expect(s.calls()).toBe(1)
    s.advance(2_000)
    await s.fleet.snapshot()
    expect(s.calls()).toBe(2)
    await s.fleet.snapshot({ fresh: true })
    await s.fleet.snapshot({ staleAfterHours: 48 })
    expect(s.calls()).toBe(4)
  })

  test('a factory failure is empty projects and a warning, and the next call asks again', async () => {
    const s = setupFleet([
      { ok: false, warning: 'factory read overview failed (exit 1)' },
      ok(fleet({ repos: [repo('p', [session()])] })),
    ])
    const down = await s.fleet.snapshot()
    expect(down.projects).toEqual([])
    expect(down.warnings).toEqual(['factory read overview failed (exit 1)'])
    expect(down.summary).toEqual({ needsYou: 0, working: 0, idle: 0, stale: 0, done: 0 })
    expect((await s.fleet.snapshot()).projects).toHaveLength(1) // the failure was not cached
  })

  test('a failed read through the reader is an unreadable view: nothing to post, nothing to classify', async () => {
    const reader = createFleet({
      factory: () => readWith(result({ exitCode: 3, stderr: 'FACTORY_TOKEN is not set' })),
      quota: quota(),
      latestOverview: async () => null,
      config: { staleAfterHours: 24 },
    })
    const view = await reader.view()
    expect(view.unreadable).toBe('factory read overview failed (exit 3): FACTORY_TOKEN is not set')
    expect(view.payload.projects).toEqual([])
    expect((await reader.read({ fresh: true })).unreadable).not.toBeNull()
  })

  test('the view of a down factory still carries the quota', async () => {
    const s = setupFleet([{ ok: false, warning: 'factory read overview failed: timed out after 10 s' }])
    const { payload } = await s.fleet.view()
    expect(payload.projects).toEqual([])
    expect(payload.warnings).toEqual(['factory read overview failed: timed out after 10 s'])
    expect(payload.quota.accounts.iu).toMatchObject({ five_hour_pct: 5, seven_day_pct: 6 })
    expect(OVERVIEW_PAYLOAD.safeParse(payload).success).toBe(true)
  })
})

/**
 * The shape Argo's ingest (`POST /agents/overview`, `routes/agents.ts`) requires, as field names and types only; copied
 * by hand, nothing imported from Argo. Every object there is loose, so extra fields ride through.
 */
function assertArgoIngest(body: Record<string, unknown>) {
  const AGENT_STATES = ['needs_you', 'working', 'idle', 'stale', 'done', 'unknown']
  const rec = (value: unknown) => value as Record<string, unknown>
  const list = (value: unknown) => value as Record<string, unknown>[]
  expect(typeof body.generatedAt).toBe('number')
  for (const key of ['needsYou', 'working', 'idle', 'stale', 'done']) {
    expect(Number.isInteger(rec(body.summary)[key])).toBe(true)
  }
  for (const project of list(body.projects)) {
    expect(typeof project.name).toBe('string')
    expect(['string', 'undefined']).toContain(typeof project.cwd)
    const git = project.git == null ? null : rec(project.git)
    if (git) {
      expect(typeof git.branch).toBe('string')
      expect(typeof git.dirty).toBe('boolean')
      expect(typeof git.ahead).toBe('number')
      expect(typeof git.behind).toBe('number')
      if (git.lastCommit != null) {
        for (const key of ['sha', 'subject', 'at']) expect(typeof rec(git.lastCommit)[key]).toBe('string')
      }
    }
    for (const agent of list(project.agents)) {
      expect(typeof agent.id).toBe('string')
      expect(AGENT_STATES).toContain(String(agent.state))
      // string, null (typeof object) or absent
      for (const key of ['title', 'lastReply', 'lastPrompt', 'paneId', 'sessionId', 'waitingFor', 'source']) {
        expect(['string', 'object', 'undefined']).toContain(typeof agent[key])
      }
      for (const key of ['lastActivityAt', 'startedAt']) {
        expect(['number', 'object', 'undefined']).toContain(typeof agent[key])
      }
    }
  }
  for (const item of list(body.humanQueue)) {
    expect(typeof item.id).toBe('string')
    expect(typeof item.question).toBe('string')
  }
  for (const w of body.warnings as unknown[]) expect(typeof w).toBe('string')
  if (body.overview != null) {
    expect(typeof rec(body.overview).generatedAt).toBe('number')
    expect(typeof rec(body.overview).model).toBe('string')
  }
}

describe('the payload', () => {
  test('a mapped fleet parses as OVERVIEW_PAYLOAD and satisfies the shape Argo’s ingest requires', async () => {
    const commit = { sha: 'a1b2c3d', subject: 'feat: x', at: '2026-11-02T10:00:00.000Z' }
    const s = setupFleet([
      ok(
        fleet({
          asks: [{ id: 'hc:1', kind: 'human', text: 'sign it', at: '2026-11-03T00:00:00.000Z' }],
          repos: [
            repo('alpha', [session({ headline: 'on it' }), session({ id: 's2', state: 'blocked', hc: 'blocked' })], {
              branch: 'master',
              dirty: false,
              lastCommit: commit,
            }),
          ],
          unplaced: [session({ id: 'u1' })],
          errors: ['one source failed'],
        }),
      ),
    ])
    const { payload } = await s.fleet.view()
    expect(OVERVIEW_PAYLOAD.safeParse(payload).success).toBe(true)
    assertArgoIngest(JSON.parse(JSON.stringify({ ...payload, machine: 'host-1' })))
    expect(payload.projects.map((p) => p.name)).toEqual(['alpha', 'unplaced'])
    expect(payload.humanQueue).toHaveLength(1)
    expect(payload.warnings).toEqual(['one source failed'])
  })
})
