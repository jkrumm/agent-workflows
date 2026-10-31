import { describe, expect, test } from 'bun:test'
import {
  buildSnapshot,
  type CollectorResult,
  type Collectors,
  defaultCollectors,
  fleetConfig,
  HC_LAUNCHD_LABEL,
  HC_REQUESTS,
  parseHcSession,
  type RunCommand,
} from '../src/fleet/collect.ts'
import { EMPTY_TAIL, type HcTerminalRaw, mergeAgents } from '../src/fleet/derive.ts'
import { AGENT } from '../src/fleet/schema.ts'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const ok = <T>(items: T[]): CollectorResult<T> => ({ items, warning: null })

const terminal = (over: Partial<HcTerminalRaw> = {}): HcTerminalRaw => ({
  address: 't7',
  cwd: '/Users/me/SourceRoot/agent-workflows',
  state: 'live',
  title: '✳ Claude Code',
  labels: { 'herdr.space': 'sp1', 'jk.claude.session': 'sess-1' },
  foreground: { cwd: '/Users/me/SourceRoot/agent-workflows' },
  status: { app: 'claude-code', state: 'working' },
  ...over,
})

const merge = (hcTerminals: HcTerminalRaw[], extra: Partial<Parameters<typeof mergeAgents>[0]> = {}) =>
  mergeAgents({
    herdrAgents: [],
    herdrWorkspaces: [],
    claudeAgents: [],
    hcTerminals,
    hcSpaces: [{ id: 'sp1', name: 'agent-workflows' }],
    transcripts: new Map(),
    now: NOW,
    staleAfterMs: 24 * 3_600_000,
    ...extra,
  })

describe('hc terminals in the merge', () => {
  test('a reporting terminal is an hc agent: session from the resume label, project from the space, status from 7501', () => {
    const [project] = merge([terminal()])
    expect(project?.name).toBe('agent-workflows')
    const [agent] = project?.agents ?? []
    expect(agent).toMatchObject({
      id: 'sess-1',
      source: 'hc',
      sessionId: 'sess-1',
      paneId: 't7',
      workspaceId: 'sp1',
      herdrStatus: 'working',
      state: 'working',
      title: null,
    })
    expect(AGENT.strict().safeParse(agent).success).toBe(true)
  })

  test('hc states map onto the runner-neutral status', () => {
    const state = (s: string) => merge([terminal({ status: { app: 'claude-code', state: s } })])[0]?.agents[0]
    expect(state('blocked')).toMatchObject({ herdrStatus: 'blocked', state: 'needs_you' })
    expect(state('done')).toMatchObject({ herdrStatus: 'done', state: 'done' })
    expect(state('idle')).toMatchObject({ herdrStatus: 'idle', state: 'idle' })
    expect(state('error')).toMatchObject({ herdrStatus: 'unknown', state: 'unknown' })
  })

  test('a shell that never reported, and a finished terminal, are not agents', () => {
    expect(merge([terminal({ status: null }), terminal({ address: 't8', state: 'finished' })])).toEqual([])
  })

  test('no session label: the address identifies the agent; no space: the cwd names the project', () => {
    const [project] = merge([terminal({ labels: {}, foreground: { cwd: '/w/some-dir' } })], { hcSpaces: [] })
    expect(project?.name).toBe('some-dir')
    expect(project?.agents[0]).toMatchObject({ id: 't7', sessionId: null, paneId: 't7', workspaceId: null })
  })

  test('a linked machine terminal keeps its prefixed address', () => {
    const agent = merge([terminal({ address: 'macbook/t3', labels: {} })])[0]?.agents[0]
    expect(agent).toMatchObject({ id: 'macbook/t3', paneId: 'macbook/t3' })
  })

  test("the title is the program's own word, then the terminal title minus its glyph, never the generic banner", () => {
    const title = (t: Partial<HcTerminalRaw>) => merge([terminal(t)])[0]?.agents[0]?.title
    expect(title({ status: { app: 'claude-code', state: 'idle', title: 'Fix the build' } })).toBe('Fix the build')
    expect(title({ title: '✳ Fix the build' })).toBe('Fix the build')
    expect(title({ title: '✳ Claude Code' })).toBeNull()
    expect(title({ title: '(wip) fix login' })).toBe('(wip) fix login')
    expect(title({ title: '#42 cleanup' })).toBe('#42 cleanup')
  })

  test('a linked machine terminal is not a local checkout: no git cwd', () => {
    const [local, remote] = [
      merge([terminal({ labels: {} })])[0],
      merge([terminal({ address: 'macbook/t3', labels: {} })])[0],
    ]
    expect(local?.gitCwd).toBe('/Users/me/SourceRoot/agent-workflows')
    expect(remote?.gitCwd).toBeNull()
    expect(remote?.cwd).toBe('/Users/me/SourceRoot/agent-workflows')
  })

  test('one session in two live terminals: the more urgent status stands, whatever the list order', () => {
    const idle = terminal({ address: 't1', status: { app: 'claude-code', state: 'idle' } })
    const blocked = terminal({ address: 't2', status: { app: 'claude-code', state: 'blocked' } })
    for (const order of [
      [idle, blocked],
      [blocked, idle],
    ]) {
      const agents = merge(order).flatMap((p) => p.agents)
      expect(agents).toHaveLength(1)
      expect(agents[0]).toMatchObject({ paneId: 't2', state: 'needs_you' })
    }
  })

  test('a herdr workspace id and an hc space id that are equal stay in their own worlds', () => {
    const projects = merge([terminal({ labels: { 'herdr.space': 'x1' } })], {
      hcSpaces: [{ id: 'x1', name: 'hc-name' }],
      herdrWorkspaces: [{ workspace_id: 'x1', label: 'herdr-name' }],
      herdrAgents: [{ pane_id: 'x1:p1', workspace_id: 'x1', agent_status: 'idle', cwd: '/c' }],
    })
    expect(projects.map((p) => p.name).toSorted()).toEqual(['hc-name', 'herdr-name'])
  })

  test('the same session in classic herdr and in hc is one agent, the hc terminal winning', () => {
    const projects = merge([terminal()], {
      herdrAgents: [{ agent_session: { value: 'sess-1' }, agent_status: 'idle', pane_id: 'w:p1', cwd: '/x' }],
    })
    const agents = projects.flatMap((p) => p.agents)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ source: 'hc', paneId: 't7' })
  })

  test('control bytes in a title, an address or a space name never reach the agent', () => {
    const ESC = String.fromCharCode(27)
    const [project] = merge([terminal({ status: { app: 'a', state: 'idle', title: `T${ESC}[2Jx` } })], {
      hcSpaces: [{ id: 'sp1', name: `S${ESC}]0;y` }],
    })
    expect(JSON.stringify(project)).not.toContain(ESC)
    expect(merge([terminal({ address: `t${ESC}1` })])).toEqual([])
  })
})

const response = (id: number, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result })

describe('parseHcSession', () => {
  const doc = { value: { spaces: [{ id: 'sp1', name: 'proj', folder: '/p', tabs: [] }, { id: 3 }] }, version: 4 }

  test('terminals with string labels, and the spaces of the herdr-app doc', () => {
    const out = [
      response(1, {
        hidden_finished: 0,
        machines: [],
        terminals: [{ address: 't1', state: 'live', labels: { a: 'b', n: 5, c: null } }, { address: 5 }, null],
      }),
      'not json',
      response(2, doc),
    ].join('\n')
    expect(parseHcSession(out)).toEqual({
      terminals: [{ address: 't1', state: 'live', labels: { a: 'b' } }],
      spaces: [{ id: 'sp1', name: 'proj' }],
      warning: 'hc terminal.list: 2 malformed row(s) dropped',
    })
  })

  test('a JSON-RPC error keeps its message in the warning', () => {
    const error = (id: number, message: string) =>
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })
    expect(parseHcSession(error(1, 'method not found')).warning).toBe('hc terminal.list: method not found')
    expect(parseHcSession(`${response(1, { terminals: [] })}\n${error(2, 'no such doc')}`).warning).toBe(
      'hc herdr-app doc unreadable: no such doc',
    )
  })

  test('no terminal list is a warning and nothing else; a missing doc is a soft warning', () => {
    expect(parseHcSession(response(2, doc)).warning).toBe('hc terminal.list returned no terminals list')
    expect(parseHcSession(response(1, { terminals: [], machines: [], hidden_finished: 0 }))).toMatchObject({
      terminals: [],
      warning: 'hc herdr-app doc unreadable',
    })
    expect(
      parseHcSession(response(1, { terminals: [] }) + '\n' + response(2, { value: null, version: 0 })).warning,
    ).toBeNull()
  })
})

describe('the hc collector', () => {
  const config = fleetConfig({}, '/nonexistent')
  const running = `gui/501/${HC_LAUNCHD_LABEL} = {\n\tstate = running\n}`

  test('asks launchd first and never calls hc while the core job is not running', async () => {
    const calls: string[][] = []
    const run: RunCommand = async (cmd) => {
      calls.push(cmd)
      return cmd[0] === 'launchctl' ? 'gui/501/job = {\n\tstate = waiting\n}' : '{}'
    }
    const hc = await defaultCollectors(config, run, { uid: 501 }).hc()
    expect(hc).toEqual({ terminals: [], spaces: [], warning: `hc core not running (launchd job ${HC_LAUNCHD_LABEL})` })
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${HC_LAUNCHD_LABEL}`]])
    expect(await defaultCollectors(config, async () => null, { uid: 501 }).hc()).toMatchObject({
      warning: expect.stringContaining('hc core not running'),
    })
  })

  test("only the job's own state counts: a nested `state = running` does not start hc", async () => {
    const calls: string[][] = []
    const run: RunCommand = async (cmd) => {
      calls.push(cmd)
      return 'gui/501/job = {\n\tstate = waiting\n\tevent triggers = {\n\t\tstate = running\n\t}\n}'
    }
    expect(await defaultCollectors(config, run, { uid: 501 }).hc()).toMatchObject({
      warning: expect.stringContaining('hc core not running'),
    })
    expect(calls).toHaveLength(1)
  })

  test('one `hc connect` session with both requests on stdin', async () => {
    const calls: { cmd: string[]; input?: string }[] = []
    const run: RunCommand = async (cmd, options) => {
      calls.push({ cmd, input: options?.input })
      if (cmd[0] === 'launchctl') return running
      return [response(1, { terminals: [{ address: 't1', labels: {} }] }), response(2, { value: { spaces: [] } })].join(
        '\n',
      )
    }
    const hc = await defaultCollectors(config, run, { uid: 501 }).hc()
    expect(hc.terminals).toHaveLength(1)
    expect(calls[1]?.cmd.slice(1)).toEqual(['connect'])
    expect(calls[1]?.input).toBe(HC_REQUESTS)
  })

  test('a failed connect is a warning', async () => {
    const run: RunCommand = async (cmd) => (cmd[0] === 'launchctl' ? running : null)
    expect(await defaultCollectors(config, run, { uid: 501 }).hc()).toMatchObject({
      warning: 'hc connect failed or timed out',
    })
  })
})

describe('buildSnapshot with hc', () => {
  test('reads the transcript of an hc session and counts it in the summary and the warnings', async () => {
    const tails: string[] = []
    const collectors: Collectors = {
      herdrAgents: async () => ok([]),
      herdrWorkspaces: async () => ok([]),
      hc: async () => ({
        terminals: [terminal()],
        spaces: [{ id: 'sp1', name: 'agent-workflows' }],
        warning: 'hc herdr-app doc unreadable',
      }),
      claudeAgents: async () => ok([]),
      humanQueue: async () => ok([]),
      transcriptTail: async (cwd, sessionId) => {
        tails.push(`${cwd}|${sessionId}`)
        return { ...EMPTY_TAIL, aiTitle: 'From the transcript', lastActivityAt: NOW }
      },
      sessionAccounts: async () => new Map([['sess-1', 'iu']]),
      git: async () => null,
    }
    const snapshot = await buildSnapshot(collectors, { now: NOW, staleAfterHours: 24 })
    expect(tails).toEqual(['/Users/me/SourceRoot/agent-workflows|sess-1'])
    expect(snapshot.summary.working).toBe(1)
    expect(snapshot.warnings).toEqual(['hc herdr-app doc unreadable'])
    expect(snapshot.projects[0]?.agents[0]).toMatchObject({
      source: 'hc',
      account: 'iu',
      title: 'From the transcript',
    })
  })
})
