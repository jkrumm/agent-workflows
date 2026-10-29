import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSnapshot,
  type CollectorResult,
  type Collectors,
  fleetConfig,
  gitProject,
  parseSessionAccounts,
  readDispatchJobs,
  type RunCommand,
  runCommand,
  sessionAccountResolver,
} from '../src/fleet/collect.ts'
import { EMPTY_TAIL } from '../src/fleet/derive.ts'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const HOUR = 3_600_000

const ok = <T>(items: T[]): CollectorResult<T> => ({ items, warning: null })

function collectors(over: Partial<Collectors> = {}): Collectors {
  return {
    herdrAgents: async () => ok([]),
    herdrWorkspaces: async () => ok([]),
    claudeAgents: async () => ok([]),
    humanQueue: () => ok([]),
    transcriptTail: async () => EMPTY_TAIL,
    dispatchJobs: async () => ok([]),
    sessionAccounts: () => new Map(),
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
        sessionAccounts: (ids) => new Map([...ids].filter((id) => id === 's1' || id === 'ds1').map((id) => [id, 'me'])),
        humanQueue: () => ok([{ id: 'q1', askedAt: null, question: 'sign', cmd: null }]),
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

  test('resolves across day files, caches hits, retries misses after the window', () => {
    const resolve = resolver()
    writeFileSync(join(dir, '2026-10-23.jsonl'), `${line('old', 'me')}\n`)
    writeFileSync(join(dir, '2026-10-24.jsonl'), `${line('new', 'iu')}\n`)
    const r = resolve(['old', 'new', 'ghost'], 1_000)
    expect(r.get('old')).toBe('me')
    expect(r.get('new')).toBe('iu')
    expect(r.has('ghost')).toBe(false)

    // the line appears later: not re-read inside the miss window, found after it
    writeFileSync(join(dir, '2026-10-24.jsonl'), `${line('ghost', 'me')}\n`)
    expect(resolve(['ghost'], 2_000).has('ghost')).toBe(false)
    expect(resolve(['ghost'], 70_000).get('ghost')).toBe('me')

    // hits survive log removal: an account never changes for a session
    rmSync(dir, { recursive: true, force: true })
    expect(resolve(['old'], 80_000).get('old')).toBe('me')
  })

  test('a spawn pin resolves without any log line; a pin whose dir is gone, or a symlink, does not', () => {
    const resolve = resolver()
    writeFileSync(join(pins, 'pinned-1.json'), JSON.stringify({ account: 'me', dir: null }))
    writeFileSync(join(pins, 'gone.json'), JSON.stringify({ account: 'me', dir: join(pins, 'missing') }))
    expect([...resolve(['pinned-1', 'gone', 'none'], 5)]).toEqual([['pinned-1', 'me']])
    const target = join(pins, 'target.json')
    writeFileSync(target, JSON.stringify({ account: 'me', dir: null }))
    Bun.spawnSync(['ln', '-s', target, join(pins, 'linked.json')])
    expect(resolve(['linked'], 6).has('linked')).toBe(false)
  })

  test('repeated misses back off exponentially (60 s, 120 s, …)', () => {
    const resolve = resolver()
    const file = join(dir, '2026-10-24.jsonl')
    writeFileSync(file, `${line('other', 'iu')}\n`)
    expect(resolve(['g'], 0).size).toBe(0) // miss 1, retry after 60 s
    writeFileSync(file, `${line('g', 'me')}\n`)
    expect(resolve(['g'], 59_000).size).toBe(0)
    writeFileSync(file, `${line('other', 'iu')}\n`)
    expect(resolve(['g'], 60_000).size).toBe(0) // miss 2, retry after 120 s
    writeFileSync(file, `${line('g', 'me')}\n`)
    expect(resolve(['g'], 120_000).size).toBe(0) // still backing off
    expect(resolve(['g'], 180_000).get('g')).toBe('me')
  })

  test('a missing log dir is unknown, no throw', () => {
    expect(sessionAccountResolver({ claudeLogDir: join(dir, 'nope'), sessionAccountsDir: pins })(['x'], 0).size).toBe(0)
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
