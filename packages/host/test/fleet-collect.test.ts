import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSnapshot,
  type CollectorResult,
  type Collectors,
  commandRunner,
  defaultCollectors,
  fleetConfig,
  gitProject,
  parseSessionAccounts,
  pickClaudeAgents,
  pickHerdrAgents,
  pickHerdrWorkspaces,
  type RunCommand,
  readDispatchJobs,
  readHumanQueue,
  readSessionPin,
  runCommand,
  sessionAccountResolver,
} from '../src/fleet/collect.ts'
import { EMPTY_TAIL, mergeAgents, parseTranscriptTail } from '../src/fleet/derive.ts'
import { AGENT } from '../src/fleet/schema.ts'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const HOUR = 3_600_000

const ok = <T>(items: T[]): CollectorResult<T> => ({ items, warning: null })

function collectors(over: Partial<Collectors> = {}): Collectors {
  return {
    herdrAgents: async () => ok([]),
    herdrWorkspaces: async () => ok([]),
    claudeAgents: async () => ok([]),
    humanQueue: async () => ok([]),
    transcriptTail: async () => EMPTY_TAIL,
    dispatchJobs: async () => ok([]),
    sessionAccounts: async () => new Map(),
    git: async () => null,
    ...over,
  }
}

describe('buildSnapshot (fake collectors)', () => {
  test('merges the sources, joins accounts and transcripts, sorts urgent first and sums the states', async () => {
    const snapshot = await buildSnapshot(
      collectors({
        herdrAgents: async () =>
          ok([
            {
              agent_session: { value: 's1' },
              agent_status: 'blocked',
              cwd: '/work/alpha',
              pane_id: 'w:p1',
              workspace_id: 'w',
              terminal_title_stripped: 'fix the build',
            },
            {
              agent_session: { value: 's2' },
              agent_status: 'working',
              cwd: '/work/beta',
              pane_id: 'w:p2',
              workspace_id: 'w2',
              terminal_title_stripped: '',
            },
          ]),
        herdrWorkspaces: async () => ok([{ workspace_id: 'w', label: 'alpha-ws' }]),
        claudeAgents: async () => ok([{ cwd: '/work/gamma', sessionId: 's3', startedAt: 5, status: 'idle' }]),
        transcriptTail: async (_cwd, sessionId) => ({
          ...EMPTY_TAIL,
          aiTitle: `title of ${sessionId}`,
          lastActivityAt: NOW - 1000,
        }),
        dispatchJobs: async () =>
          ok([
            {
              id: 'job1',
              status: 'running',
              cwd: '/work/delta',
              tier: 'implement',
              createdAt: NOW - 5000,
              startedAt: NOW - 4000,
              finishedAt: null,
              sessionId: 'ds1',
            },
          ]),
        sessionAccounts: async (ids) =>
          new Map([...ids].filter((id) => id === 's1' || id === 'ds1').map((id) => [id, 'me'])),
        humanQueue: async () => ok([{ id: 'q1', askedAt: null, question: 'sign', cmd: null }]),
        git: async (cwd) => ({ branch: cwd.slice(-1), dirty: false, ahead: 0, behind: 0, lastCommit: null }),
      }),
      { now: NOW, staleAfterHours: 24 },
    )

    expect(snapshot.generatedAt).toBe(NOW)
    expect(snapshot.summary).toEqual({ needsYou: 1, working: 2, idle: 0, stale: 0, done: 0, dispatch: 1 })
    expect(snapshot.projects.map((p) => p.name)).toEqual(['alpha-ws', 'beta', 'delta', 'gamma'])
    const agents = Object.fromEntries(snapshot.projects.flatMap((p) => p.agents).map((a) => [a.id, a]))
    expect(agents.s1).toMatchObject({ state: 'needs_you', account: 'me', title: 'fix the build' })
    expect(agents.s2).toMatchObject({ state: 'working', account: null, title: 'title of s2' })
    expect(agents.job1).toMatchObject({ source: 'dispatch', account: 'me', tier: 'implement', state: 'working' })
    expect(agents.s3).toMatchObject({ source: 'claude', state: 'unknown' })
    expect(snapshot.humanQueue).toHaveLength(1)
    expect(snapshot.projects[0]?.git?.branch).toBe('a')
  })

  test('a failing collector is a warning, never a failure', async () => {
    const snapshot = await buildSnapshot(
      collectors({
        herdrAgents: async () => ({ items: [], warning: 'herdr agent list failed or timed out' }),
        dispatchJobs: async () => ({ items: [], warning: 'agent-gateway dispatch jobs unavailable: HTTP 500' }),
        claudeAgents: async () => ok([{ cwd: '/w/x', sessionId: 's', startedAt: 1, status: 'busy' }]),
        git: async () => {
          throw new Error('git blew up')
        },
      }),
      { now: NOW, staleAfterHours: 24 },
    )
    expect(snapshot.warnings).toEqual([
      'herdr agent list failed or timed out',
      'agent-gateway dispatch jobs unavailable: HTTP 500',
      'git status failed for x: Error: git blew up',
    ])
    expect(snapshot.projects[0]?.git).toBeNull()
  })

  test('reads a transcript once per session even when herdr and the registry both list it', async () => {
    const reads: string[] = []
    await buildSnapshot(
      collectors({
        herdrAgents: async () =>
          ok([
            {
              agent_session: { value: 's1' },
              agent_status: 'idle',
              cwd: '/w/x',
              pane_id: 'p',
              workspace_id: 'w',
              terminal_title_stripped: 't',
            },
          ]),
        claudeAgents: async () => ok([{ cwd: '/w/x', sessionId: 's1', startedAt: 1, status: 'idle' }]),
        transcriptTail: async (_cwd, id) => {
          reads.push(id)
          return EMPTY_TAIL
        },
      }),
      { now: NOW, staleAfterHours: 24 },
    )
    expect(reads).toEqual(['s1'])
  })

  test('the stale threshold is the caller’s: 48 h keeps a day-old idle pane idle', async () => {
    const pane = {
      agent_session: { value: 's1' },
      agent_status: 'idle',
      cwd: '/w/x',
      pane_id: 'p',
      workspace_id: 'w',
      terminal_title_stripped: 't',
    }
    const build = (hours: number) =>
      buildSnapshot(
        collectors({
          herdrAgents: async () => ok([pane]),
          transcriptTail: async () => ({ ...EMPTY_TAIL, lastActivityAt: NOW - 30 * HOUR }),
        }),
        { now: NOW, staleAfterHours: hours },
      )
    expect((await build(24)).summary.stale).toBe(1)
    expect((await build(48)).summary.idle).toBe(1)
  })
})

describe('readDispatchJobs (fake agent-gateway)', () => {
  const job = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    tool: 'dispatch',
    status: 'running',
    createdAt: NOW - 1000,
    startedAt: NOW - 900,
    finishedAt: null,
    params: { cwd: `/work/${id}`, tier: 'author' },
    sessionId: `sess-${id}`,
    ...over,
  })
  const gateway = (jobs: ReturnType<typeof job>[]) =>
    (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/jobs') {
        return Response.json({ ok: true, jobs: jobs.map(({ params: _p, sessionId: _s, ...view }) => view) })
      }
      const found = jobs.find((j) => path === `/api/jobs/${j.id}`)
      return found ? Response.json({ ok: true, job: found }) : new Response('nope', { status: 404 })
    }) as unknown as typeof fetch

  test('keeps running, queued and recently finished dispatch jobs, with params and session from the detail', async () => {
    const result = await readDispatchJobs(
      'http://gw',
      NOW,
      gateway([
        job('run'),
        job('queued', { status: 'pending', startedAt: null }),
        job('recent', { status: 'done', finishedAt: NOW - HOUR }),
        job('old', { status: 'done', finishedAt: NOW - 7 * HOUR }),
        job('other', { tool: 'triage' }),
        job('nocwd', { params: {} }),
      ]),
    )
    expect(result.warning).toBeNull()
    expect(result.items.map((j) => j.id)).toEqual(['run', 'queued', 'recent'])
    expect(result.items[0]).toMatchObject({
      cwd: '/work/run',
      tier: 'author',
      sessionId: 'sess-run',
      status: 'running',
    })
  })

  test('an agent-gateway that is down or answers an error is a warning with no jobs', async () => {
    const down = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const refused = await readDispatchJobs('http://gw', NOW, down)
    expect(refused.items).toEqual([])
    expect(refused.warning).toContain('agent-gateway dispatch jobs unavailable')
    const broken = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    expect((await readDispatchJobs('http://gw', NOW, broken)).warning).toContain('HTTP 500')
  })
})

describe('session accounts', () => {
  let dir: string
  let pins: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-logs-'))
    pins = mkdtempSync(join(tmpdir(), 'pins-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(pins, { recursive: true, force: true })
  })
  const line = (session: string, account?: string, event = 'session_env') =>
    JSON.stringify({ ts: 't', event, data: { session, ...(account ? { account } : {}) } })
  const resolver = () => sessionAccountResolver({ claudeLogDir: dir, sessionAccountsDir: pins })

  test('parse: the newest line wins, lines without an account and other events are skipped', () => {
    const m = parseSessionAccounts(
      [line('a', 'iu'), line('a', 'me'), line('b'), line('c', 'iu', 'other'), 'garbage', '{"event":"session_env"'].join(
        '\n',
      ),
    )
    expect([...m]).toEqual([['a', 'me']])
  })

  test('resolves across day files, caches hits, retries misses after the window', async () => {
    const resolve = resolver()
    writeFileSync(join(dir, '2026-10-23.jsonl'), `${line('old', 'me')}\n`)
    writeFileSync(join(dir, '2026-10-24.jsonl'), `${line('new', 'iu')}\n`)
    const r = await resolve(['old', 'new', 'ghost'], 1_000)
    expect(r.get('old')).toBe('me')
    expect(r.get('new')).toBe('iu')
    expect(r.has('ghost')).toBe(false)

    // the line appears later: not re-read inside the miss window, found after it
    writeFileSync(join(dir, '2026-10-24.jsonl'), `${line('ghost', 'me')}\n`)
    expect((await resolve(['ghost'], 2_000)).has('ghost')).toBe(false)
    expect((await resolve(['ghost'], 70_000)).get('ghost')).toBe('me')

    // hits survive log removal: an account never changes for a session
    rmSync(dir, { recursive: true, force: true })
    expect((await resolve(['old'], 80_000)).get('old')).toBe('me')
  })

  test('a spawn pin resolves without any log line; a pin whose dir is gone, or a symlink, does not', async () => {
    const resolve = resolver()
    writeFileSync(join(pins, 'pinned-1.json'), JSON.stringify({ account: 'me', dir: null }))
    writeFileSync(join(pins, 'gone.json'), JSON.stringify({ account: 'me', dir: join(pins, 'missing') }))
    expect([...(await resolve(['pinned-1', 'gone', 'none'], 5))]).toEqual([['pinned-1', 'me']])
    const target = join(pins, 'target.json')
    writeFileSync(target, JSON.stringify({ account: 'me', dir: null }))
    Bun.spawnSync(['ln', '-s', target, join(pins, 'linked.json')])
    expect((await resolve(['linked'], 6)).has('linked')).toBe(false)
  })

  test('repeated misses back off exponentially (60 s, 120 s, …)', async () => {
    const resolve = resolver()
    const file = join(dir, '2026-10-24.jsonl')
    writeFileSync(file, `${line('other', 'iu')}\n`)
    expect((await resolve(['g'], 0)).size).toBe(0) // miss 1, retry after 60 s
    writeFileSync(file, `${line('g', 'me')}\n`)
    expect((await resolve(['g'], 59_000)).size).toBe(0)
    writeFileSync(file, `${line('other', 'iu')}\n`)
    expect((await resolve(['g'], 60_000)).size).toBe(0) // miss 2, retry after 120 s
    writeFileSync(file, `${line('g', 'me')}\n`)
    expect((await resolve(['g'], 120_000)).size).toBe(0) // still backing off
    expect((await resolve(['g'], 180_000)).get('g')).toBe('me')
  })

  test('a missing log dir is unknown, no throw', async () => {
    expect(
      (await sessionAccountResolver({ claudeLogDir: join(dir, 'nope'), sessionAccountsDir: pins })(['x'], 0)).size,
    ).toBe(0)
  })
})

describe('gitProject (a real repository)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-git-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  }

  test('branch, dirtiness and the newest commit beyond the main branch', async () => {
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'b.txt'), 'b')
    git('add', '.')
    git('commit', '-q', '-m', 'feature work')
    writeFileSync(join(dir, 'c.txt'), 'untracked')

    const status = await gitProject(runCommand, dir)
    expect(status).toMatchObject({
      branch: 'feature',
      dirty: true,
      ahead: 0,
      behind: 0,
      lastCommit: { subject: 'feature work' },
    })
    expect(status?.lastCommit?.sha).toMatch(/^[0-9a-f]{7,}$/)
    expect(status?.lastCommit?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('on the main branch the newest main commit stands; a clean tree is not dirty', async () => {
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a')
    git('add', '.')
    git('commit', '-q', '-m', 'only commit')
    expect(await gitProject(runCommand, dir)).toMatchObject({
      branch: 'main',
      dirty: false,
      lastCommit: { subject: 'only commit' },
    })
  })

  test('a directory that is not a repository is null', async () => {
    expect(await gitProject(runCommand, dir)).toBeNull()
  })

  test('a failing command is null for every query, so the port is the only seam', async () => {
    const never: RunCommand = async () => null
    expect(await gitProject(never, dir)).toBeNull()
  })
})

describe('fleetConfig', () => {
  test('defaults under the home dir; every path has an override name', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    try {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(join(home, '.local', 'bin', 'herdr'), '')
      const config = fleetConfig({}, home)
      expect(config.herdrBin).toBe(join(home, '.local', 'bin', 'herdr'))
      expect(config.claudeBin).toBe('claude') // not installed there: found on PATH
      expect(config.humanQueueDir).toBe(join(home, '.local', 'state', 'human-queue'))
      expect(config.claudeLogDir).toBe(join(home, '.claude', 'logs'))
      expect(config.agentGatewayUrl).toBe('http://localhost:7705')
      expect(config.staleAfterHours).toBe(24)

      const custom = fleetConfig(
        {
          AGW_HERDR_BIN: '/opt/herdr',
          XDG_STATE_HOME: '/state',
          AGW_CLAUDE_LOG_DIR: '/logs',
          AGW_SESSION_ACCOUNTS_DIR: '/pins',
          AGW_AGENT_GATEWAY_URL: 'http://gw:1/',
          AGW_AGENT_STALE_HOURS: '48',
        },
        home,
      )
      expect(custom).toMatchObject({
        herdrBin: '/opt/herdr',
        humanQueueDir: '/state/human-queue',
        claudeLogDir: '/logs',
        sessionAccountsDir: '/pins',
        agentGatewayUrl: 'http://gw:1',
        staleAfterHours: 48,
      })
      expect(fleetConfig({ AGW_AGENT_STALE_HOURS: 'x' }, home).staleAfterHours).toBe(24)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('children get a minimal environment', () => {
  test('PATH, HOME, TMPDIR and LANG pass; the host’s secrets and everything else do not', async () => {
    const run = commandRunner({
      PATH: process.env.PATH,
      HOME: '/home/x',
      LANG: 'C',
      AGW_API_SECRET: 'api-secret',
      ARGO_API_SECRET: 'argo-secret',
      IU_API_KEY: 'iu-key',
    })
    const out = (await run(['env'])) ?? ''
    expect(out).toContain('HOME=/home/x')
    expect(out).toContain('GIT_TERMINAL_PROMPT=0')
    expect(out).toContain('GIT_OPTIONAL_LOCKS=0')
    expect(out).not.toMatch(/secret|IU_API_KEY|iu-key/i)
  })

  test('only a network call (git fetch) also gets the SSH agent, config dir and proxy/CA variables', async () => {
    const run = commandRunner({
      PATH: process.env.PATH,
      HOME: '/home/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      XDG_CONFIG_HOME: '/home/x/.config',
      HTTPS_PROXY: 'http://proxy.example.com:3128',
      SSL_CERT_FILE: '/etc/ca.pem',
      AGW_API_SECRET: 'api-secret',
      ARGO_API_SECRET: 'argo-secret',
      IU_API_KEY: 'iu-key',
    })
    const local = (await run(['env'])) ?? ''
    expect(local).not.toMatch(/SSH_AUTH_SOCK|XDG_CONFIG_HOME|PROXY|SSL_CERT_FILE/)
    const network = (await run(['env'], { network: true })) ?? ''
    expect(network).toContain('SSH_AUTH_SOCK=/tmp/agent.sock')
    expect(network).toContain('XDG_CONFIG_HOME=/home/x/.config')
    expect(network).toContain('HTTPS_PROXY=http://proxy.example.com:3128')
    expect(network).toContain('SSL_CERT_FILE=/etc/ca.pem')
    expect(network).toContain('GIT_OPTIONAL_LOCKS=0')
    expect(network).not.toMatch(/secret|IU_API_KEY|iu-key/i)
  })

  test('gitProject: only the fetch asks for the network, and an empty cwd runs nothing', async () => {
    const calls: { cmd: string[]; network: boolean }[] = []
    const run: RunCommand = async (cmd, options) => {
      calls.push({ cmd, network: options?.network === true })
      return null
    }
    expect(await gitProject(run, '')).toBeNull()
    expect(calls).toHaveLength(0)
    await gitProject(run, '/work/x')
    expect(calls.filter((c) => c.network).map((c) => c.cmd[3])).toEqual(['fetch'])
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('collector output is shape-validated', () => {
  test('herdr rows: wrong types and null or scalar elements are dropped and counted, never thrown', () => {
    const picked = pickHerdrAgents({
      result: {
        agents: [
          { agent_session: { value: 's1' }, agent_status: 'idle', cwd: '/w' },
          null,
          'x',
          7,
          { cwd: 5 },
          { agent_session: { value: 9 } },
          { agent_session: 'nope' },
          { pane_id: null, cwd: null },
        ],
      },
    })
    expect(picked.items).toHaveLength(2)
    expect(picked.dropped).toBe(6)
    expect(pickHerdrAgents({ result: {} })).toEqual({ items: [], dropped: 0 })
    expect(pickHerdrAgents(null)).toEqual({ items: [], dropped: 0 })
    expect(() => pickHerdrAgents({ result: { agents: 'not a list' } })).toThrow()
  })

  test('a pane without a session (`{}`, `{ value: null }`, null) is a valid row, and an agent of its own', () => {
    const picked = pickHerdrAgents({
      result: {
        agents: [
          { agent_session: {}, pane_id: 'w:p1', cwd: '/w/a', agent_status: 'idle' },
          { agent_session: { value: null }, pane_id: 'w:p2', cwd: '/w/b', agent_status: 'blocked' },
          { agent_session: null, pane_id: 'w:p3', cwd: '/w/c', agent_status: 'working' },
        ],
      },
    })
    expect(picked).toMatchObject({ dropped: 0 })
    expect(picked.items).toHaveLength(3)
    const agents = mergeAgents({
      herdrAgents: picked.items,
      herdrWorkspaces: [],
      claudeAgents: [],
      dispatchJobs: [],
      transcripts: new Map(),
      now: 10,
      staleAfterMs: 1000,
    }).flatMap((p) => p.agents)
    expect(agents.map((a) => [a.id, a.sessionId]).toSorted()).toEqual([
      ['w:p1', null],
      ['w:p2', null],
      ['w:p3', null],
    ])
  })

  test('workspaces and registry rows', () => {
    expect(
      pickHerdrWorkspaces({ result: { workspaces: [{ workspace_id: 'w', label: 'l' }, { workspace_id: 'w' }, null] } }),
    ).toMatchObject({ dropped: 2, items: [{ workspace_id: 'w', label: 'l' }] })
    expect(
      pickClaudeAgents([
        { sessionId: 's', startedAt: 1 },
        { sessionId: 's', startedAt: 'late' },
        null,
        [],
        { status: 4 },
      ]),
    ).toMatchObject({ dropped: 4, items: [{ sessionId: 's', startedAt: 1 }] })
  })

  test('a collector with malformed rows answers a warning and the good rows', async () => {
    const run: RunCommand = async (cmd) =>
      cmd.includes('agent')
        ? JSON.stringify({ result: { agents: [null, { agent_session: { value: 's' } }] } })
        : '{"result":'
    const c = defaultCollectors(fleetConfig({}, '/nonexistent'), run)
    const agents = await c.herdrAgents()
    expect(agents.items).toHaveLength(1)
    expect(agents.warning).toBe('herdr agent list: 1 malformed row(s) dropped')
    expect((await c.herdrWorkspaces()).warning).toBe('herdr workspace list returned unparseable JSON')
  })

  test('the snapshot is stamped after the transcript tails, so no tail line is newer than it', async () => {
    const snapshot = await buildSnapshot(
      collectors({
        herdrAgents: async () => ok([{ agent_session: { value: 's1' }, agent_status: 'idle', cwd: '/work/x' }]),
        transcriptTail: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15))
          return { ...EMPTY_TAIL, lastActivityAt: Date.now() } // the agent moved while its tail was being read
        },
      }),
      { staleAfterHours: 24 },
    )
    const activity = snapshot.projects[0]?.agents[0]?.lastActivityAt ?? Number.POSITIVE_INFINITY
    expect(snapshot.generatedAt).toBeGreaterThanOrEqual(activity)
  })

  test('git status runs in the raw cwd and is skipped for a cwd that is not a safe argument', async () => {
    const gits: string[] = []
    await buildSnapshot(
      collectors({
        herdrAgents: async () =>
          ok([
            { agent_session: { value: 'a' }, agent_status: 'idle', cwd: '/work/two  spaces' },
            { agent_session: { value: 'b' }, agent_status: 'idle', cwd: '/work/new\nline' },
          ]),
        git: async (cwd) => {
          gits.push(cwd)
          return null
        },
      }),
      { now: NOW, staleAfterHours: 24 },
    )
    expect(gits).toEqual(['/work/two  spaces'])
  })

  test('a row without a cwd gets no transcript read and no git call', async () => {
    const reads: string[] = []
    const gits: string[] = []
    const snapshot = await buildSnapshot(
      collectors({
        herdrAgents: async () => ok([{ agent_session: { value: 's1' }, agent_status: 'idle' }]),
        transcriptTail: async (cwd) => {
          reads.push(cwd)
          return EMPTY_TAIL
        },
        git: async (cwd) => {
          gits.push(cwd)
          return null
        },
      }),
      { now: NOW, staleAfterHours: 24 },
    )
    expect(snapshot.projects[0]?.agents).toHaveLength(1)
    expect(reads).toEqual([])
    expect(gits).toEqual([])
  })

  test('transcript tails and git statuses run at most 8 at a time', async () => {
    let inFlight = 0
    let peak = 0
    const slow = async <T>(value: T): Promise<T> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return value
    }
    await buildSnapshot(
      collectors({
        herdrAgents: async () =>
          ok(
            Array.from({ length: 30 }, (_, i) => ({
              agent_session: { value: `s${i}` },
              agent_status: 'idle',
              cwd: `/work/p${i}`,
            })),
          ),
        transcriptTail: (_cwd, _id) => slow(EMPTY_TAIL),
        git: () => slow(null),
      }),
      { now: NOW, staleAfterHours: 24 },
    )
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})

describe('the human queue and session pins are read async and bounded', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a missing directory is an empty queue; answered, hidden and oversized requests are not entries', async () => {
    expect(await readHumanQueue(join(dir, 'absent'))).toEqual({ items: [], warning: null })
    const req = (id: string, text: string) => writeFileSync(join(dir, `${id}.req`), JSON.stringify({ text }))
    req('20260101-a', 'open')
    req('20260101-b', 'answered')
    writeFileSync(join(dir, '20260101-b.res'), '{}')
    writeFileSync(join(dir, '.20260101-c.req'), '{"text":"hidden"}')
    writeFileSync(join(dir, '20260101-big.req'), JSON.stringify({ text: 'x'.repeat(100_000) }))
    const queue = await readHumanQueue(dir)
    expect(queue.items.map((e) => e.id)).toEqual(['20260101-a'])
    expect(queue.warning).toContain('1 request(s) skipped')
  })

  test('at most 200 files are read, newest first', async () => {
    for (let i = 0; i < 230; i++) {
      writeFileSync(join(dir, `${String(i).padStart(4, '0')}.req`), JSON.stringify({ text: `q${i}` }))
    }
    const queue = await readHumanQueue(dir)
    expect(queue.items).toHaveLength(200)
    expect(queue.items[0]?.id).toBe('0229')
    expect(queue.items.at(-1)?.id).toBe('0030')
    expect(queue.warning).toContain('30 request(s) skipped')
  })

  test('a pin whose dir is gone is no pin; an existing one is', async () => {
    writeFileSync(join(dir, 's1.json'), JSON.stringify({ account: 'iu', dir }))
    writeFileSync(join(dir, 's2.json'), JSON.stringify({ account: 'iu', dir: join(dir, 'gone') }))
    expect(await readSessionPin(dir, 's1')).toBe('iu')
    expect(await readSessionPin(dir, 's2')).toBeNull()
  })
})

describe('a session id is a path segment', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'projects-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('only [A-Za-z0-9_-] reaches the transcript path: a traversal reads nothing', async () => {
    mkdirSync(join(dir, 'projects', '-work-x'), { recursive: true })
    const line = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-29T10:00:00Z',
        message: { content: [{ type: 'text', text }] },
      })
    writeFileSync(join(dir, 'projects', '-work-x', 'good-1.jsonl'), line('inside'))
    writeFileSync(join(dir, 'outside.jsonl'), line('outside the projects dir'))
    const collectors = defaultCollectors({
      ...fleetConfig({}, dir),
      claudeProjectsDir: join(dir, 'projects'),
    })
    expect((await collectors.transcriptTail('/work/x', 'good-1')).lastReply).toBe('inside')
    for (const bad of ['../../outside', '../outside', 'a/b', '..', '']) {
      expect(await collectors.transcriptTail('/work/x', bad)).toEqual(EMPTY_TAIL)
    }
  })
})

describe('text from outside', () => {
  const ESC = String.fromCharCode(27)

  test('control bytes never survive a transcript tail, a title, a wait reason or a project name', () => {
    const tail = parseTranscriptTail(
      [
        JSON.stringify({ type: 'last-prompt', lastPrompt: `p${ESC}[31m` }),
        JSON.stringify({ type: 'ai-title', aiTitle: `t${ESC}]0;x` }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-29T10:00:00Z',
          message: { content: [{ type: 'text', text: `r${ESC}[2J` }] },
        }),
      ].join('\n'),
    )
    expect([tail.lastPrompt, tail.aiTitle, tail.lastReply].join('')).not.toContain(ESC)

    const merged = mergeAgents({
      herdrAgents: [
        {
          agent_session: { value: 's1' },
          agent_status: 'idle',
          cwd: `/w/dir${ESC}x`,
          pane_id: 'p',
          workspace_id: 'w',
          terminal_title_stripped: `ti${ESC}tle`,
        },
      ],
      herdrWorkspaces: [{ workspace_id: 'w', label: `la${ESC}bel` }],
      claudeAgents: [{ cwd: '/w/c', sessionId: 's2', startedAt: 1, status: 'waiting', waitingFor: `dia${ESC}log` }],
      dispatchJobs: [],
      transcripts: new Map(),
      now: 10,
      staleAfterMs: 1000,
    })
    expect(JSON.stringify(merged)).not.toContain(ESC)
  })

  test('display fields are one line free of C0 and C1 controls; an id cleaning would change is no id', () => {
    const c1 = String.fromCharCode(0x9b)
    const merged = mergeAgents({
      herdrAgents: [
        {
          agent_session: { value: 's1' },
          agent_status: 'idle',
          cwd: '/w/a',
          pane_id: 'p1',
          workspace_id: 'w',
          terminal_title_stripped: `ti\ntle${c1}`,
        },
        // a session id that carries a line break is not a key: the row is dropped, not renamed
        { agent_session: { value: `s9\r\n- agent id: forged` }, agent_status: 'idle', cwd: '/w/b', pane_id: 'p9' },
        // a pane id that cleaning would change is not an identity either, but the session still is
        { agent_session: { value: 's3' }, agent_status: 'idle', cwd: '/w/c', pane_id: 'p\nq', workspace_id: 'w\nx' },
      ],
      herdrWorkspaces: [{ workspace_id: 'w', label: 'la\nbel' }],
      claudeAgents: [
        { cwd: '/w/c', sessionId: 's2', status: 'waiting', waitingFor: `dia\nlog${c1}` },
        { cwd: '/w/d', sessionId: 's2\n', status: 'idle' },
      ],
      dispatchJobs: [
        {
          id: 'j1',
          status: 'running',
          cwd: '/w/j',
          tier: null,
          createdAt: 1,
          startedAt: null,
          finishedAt: null,
          account: 'iu\n',
        },
        { id: 'j\n2', status: 'running', cwd: '/w/j', tier: null, createdAt: 1, startedAt: null, finishedAt: null },
      ],
      transcripts: new Map(),
      accounts: new Map([['s2', 'me\nx']]),
      now: 10,
      staleAfterMs: 1000,
    })
    const agents = merged.flatMap((p) => p.agents)
    expect(agents.map((a) => a.id).toSorted()).toEqual(['j1', 's1', 's2', 's3'])
    const fields = agents.flatMap((a) => [a.id, a.sessionId, a.paneId, a.workspaceId, a.title, a.waitingFor, a.account])
    for (const value of fields) expect(value ?? '').not.toMatch(/[\r\n\u0080-\u009f]/)
    expect(agents.find((a) => a.id === 's1')).toMatchObject({ title: 'ti tle', workspaceId: 'w' })
    expect(agents.find((a) => a.id === 's3')).toMatchObject({ paneId: null, workspaceId: null })
    expect(agents.find((a) => a.source === 'claude')).toMatchObject({ waitingFor: 'dia log', account: 'me x' })
    expect(agents.find((a) => a.source === 'dispatch')).toMatchObject({ id: 'j1', account: 'iu' })
    // the project is named from the workspace label, found by the raw workspace id
    expect(merged.map((p) => p.name)).toContain('la bel')
  })

  test('git runs in the raw cwd, never the display one; a cwd with a control byte or a line break gets no git', () => {
    const merged = mergeAgents({
      herdrAgents: [
        { agent_session: { value: 'a' }, agent_status: 'idle', cwd: '/work/two  spaces' },
        { agent_session: { value: 'b' }, agent_status: 'idle', cwd: '/work/new\nline' },
        { agent_session: { value: 'c' }, agent_status: 'idle', cwd: `/work/esc${String.fromCharCode(0x1b)}` },
        { agent_session: { value: 'd' }, agent_status: 'idle', cwd: '' },
      ],
      herdrWorkspaces: [],
      claudeAgents: [],
      dispatchJobs: [],
      transcripts: new Map(),
      now: 10,
      staleAfterMs: 1000,
    })
    const byId = (id: string) => merged.find((p) => p.agents.some((a) => a.id === id))
    expect(byId('a')).toMatchObject({ gitCwd: '/work/two  spaces', cwd: '/work/two spaces' })
    expect(byId('b')?.gitCwd).toBeNull()
    expect(byId('c')?.gitCwd).toBeNull()
    expect(byId('d')?.gitCwd).toBeNull()
  })

  test('a sparse herdr or registry row is null-filled and still passes the strict agent schema', () => {
    const merged = mergeAgents({
      herdrAgents: [{ agent_session: { value: 's1' } }, { pane_id: 'only-pane' }, {}],
      herdrWorkspaces: [],
      claudeAgents: [{ sessionId: 's2' }, { cwd: '/w/nosession' }, {}],
      dispatchJobs: [],
      transcripts: new Map(),
      now: 10,
      staleAfterMs: 1000,
    })
    const agents = merged.flatMap((p) => p.agents)
    expect(agents.map((a) => a.id).toSorted()).toEqual(['only-pane', 's1', 's2'])
    for (const agent of agents) expect(AGENT.strict().safeParse(agent).success).toBe(true)
    expect(agents.find((a) => a.id === 's2')).toMatchObject({ startedAt: null, paneId: null })
  })
})

describe('readDispatchJobs partial failure', () => {
  test('a detail that fails costs one warning for the failures; the others are kept', async () => {
    const job = (id: string) => ({
      id,
      tool: 'dispatch',
      status: 'running',
      createdAt: NOW - 1000,
      startedAt: NOW - 900,
      finishedAt: null,
      params: { cwd: `/work/${id}` },
      sessionId: null,
    })
    const jobs = [job('a'), job('b'), job('c')]
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/jobs') return Response.json({ jobs })
      if (path.endsWith('/b')) return new Response('boom', { status: 500 })
      return Response.json({ job: jobs.find((j) => path.endsWith(`/${j.id}`)) })
    }) as unknown as typeof fetch
    const result = await readDispatchJobs('http://gw', NOW, fetcher)
    expect(result.items.map((j) => j.id)).toEqual(['a', 'c'])
    expect(result.warning).toBe('agent-gateway dispatch jobs: 1 of 3 could not be read')
  })
})
