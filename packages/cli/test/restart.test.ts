// A deploy restarts the host: the CLI waits it out (a refused connection sent nothing, so every command may wait) and
// retries a lost answer itself with the key it already carries. Black-box, as the conformance suite: spawn
// `bin/agw.ts` against a fake host that is down first and comes up later.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restartBoundS } from '../src/config.ts'
import { type FakeHost, FIXTURE_WORKFLOWS, type RunStore, startFakeHost, type Workflow } from './fake-host.ts'

setDefaultTimeout(60_000)

const BIN = join(import.meta.dir, '..', 'bin', 'agw.ts')
const SECRET = 'conformance-secret-0123456789abcdef'
const HOST_LABEL = 'com.jkrumm.agent-workflows-host'

const SMOKE_PING: Workflow = {
  id: 'smoke.ping',
  summary: 'Answers pong',
  input: { type: 'object', properties: {} },
  outcome: () => ({ output: { title: 'pong' } }),
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A sandbox HOME; `deploying` writes the marker `scripts/deploy.sh` leaves when it stops the host on purpose. */
function sandbox({ deploying }: { deploying: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'agw-restart-'))
  dirs.push(dir)
  if (deploying) markRestart(dir, Math.floor(Date.now() / 1000))
  return dir
}

function markRestart(home: string, epoch: number) {
  const marks = join(home, '.local', 'state', 'devhost', 'deliberate-restart')
  mkdirSync(marks, { recursive: true })
  writeFileSync(join(marks, HOST_LABEL), `${epoch}\n`)
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = probe.port as number
  await probe.stop(true)
  return port
}

function agw(home: string, url: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_CONFIG_HOME: join(home, 'config'),
      AGW_URL: url,
      AGW_API_SECRET: SECRET,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  })()
}

interface ErrorLine {
  error: { kind: string; message: string; hint: string }
}
const lastJson = (text: string) => JSON.parse(text.trim().split('\n').at(-1) ?? '{}') as ErrorLine

describe('the restart bound', () => {
  const label = HOST_LABEL
  test('a deploy that marked its restart gets the full bound; a process that is just down gets at most 30 s', () => {
    const home = sandbox({ deploying: false })
    expect(restartBoundS({ HOME: home }, label)).toEqual({ boundS: 30, deploying: false })
    markRestart(home, Math.floor(Date.now() / 1000) - 5)
    expect(restartBoundS({ HOME: home }, label)).toEqual({ boundS: 90, deploying: true })
    markRestart(home, Math.floor(Date.now() / 1000) - 600)
    expect(restartBoundS({ HOME: home }, label)).toEqual({ boundS: 30, deploying: false })
  })

  test('AGW_RESTART_WAIT_S overrides the full bound; 0 never waits', () => {
    const home = sandbox({ deploying: true })
    expect(restartBoundS({ HOME: home, AGW_RESTART_WAIT_S: '200' }, label).boundS).toBe(200)
    expect(restartBoundS({ HOME: home, AGW_RESTART_WAIT_S: '10' }, label).boundS).toBe(10)
    expect(restartBoundS({ HOME: home, AGW_RESTART_WAIT_S: '0' }, label).boundS).toBe(0)
  })
})

describe('a host that is down for 20 s', () => {
  test('a ping and a workflow start started while it is down both finish with exit 0 and a clean stdout', async () => {
    const home = sandbox({ deploying: true })
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const ping = agw(home, url, ['smoke', 'ping'])
    const echo = agw(home, url, ['fixture', 'echo', 'hello'])
    await Bun.sleep(20_000)
    const host = await startFakeHost({ port, workflows: [SMOKE_PING, ...FIXTURE_WORKFLOWS] })
    try {
      const [pinged, echoed] = await Promise.all([ping, echo])
      expect(pinged.code).toBe(0)
      expect(JSON.parse(pinged.stdout)).toMatchObject({ status: 'done', output: { title: 'pong' } })
      expect(pinged.stderr).toBe('host restarting, waiting\n')
      expect(echoed.code).toBe(0)
      expect(JSON.parse(echoed.stdout)).toMatchObject({ status: 'done', output: { echo: 'hello' } })
      expect(echoed.stderr).toBe('host restarting, waiting\n')
    } finally {
      await host.stop()
    }
  })

  test('a host that stays down fails with the unreachable error once the bound is spent, never with a may-have-started hint', async () => {
    const home = sandbox({ deploying: false })
    const url = `http://127.0.0.1:${await freePort()}`
    const started = Date.now()
    const result = await agw(home, url, ['fixture', 'deploy', '--target', 'x', '--commit'], { AGW_RESTART_WAIT_S: '2' })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.code).toBe(7)
    const { error } = lastJson(result.stderr)
    expect(error.kind).toBe('network')
    expect(error.message).toContain('host unreachable at')
    expect(error.hint).not.toContain('may have started')
    expect(result.stdout).toBe('')
  })

  test('AGW_RESTART_WAIT_S=0 fails at once', async () => {
    const home = sandbox({ deploying: true })
    const url = `http://127.0.0.1:${await freePort()}`
    const result = await agw(home, url, ['smoke', 'ping'], { AGW_RESTART_WAIT_S: '0' })
    expect(result.code).toBe(7)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })
})

describe('a start whose answer is lost', () => {
  const deploy = ['fixture', 'deploy', '--target', 'x', '--commit']
  const starts = (host: FakeHost) => host.requests.filter((r) => r.path === '/workflows/fixture/deploy')

  async function started(options: { lostAnswers?: number; refuseStarts?: { count: number; status: number } }) {
    const runs: RunStore = new Map()
    const host = await startFakeHost({ runs, ...options })
    const result = await agw(sandbox({ deploying: true }), host.url, deploy, { AGW_API_SECRET: host.secret })
    await host.stop()
    return { runs, host, result }
  }

  test('is retried by the CLI with the same idempotency key and yields one run', async () => {
    const { runs, host, result } = await started({ lostAnswers: 1 })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'done', output: { deployed: 'x' } })
    const keys = starts(host).map((r) => r.headers['idempotency-key'])
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBeTruthy()
    expect(runs.size).toBe(1)
  })

  test('a host that is cut and then stays down still hands the key back: the first attempt may have landed', async () => {
    const runs: RunStore = new Map()
    const host = await startFakeHost({ runs, lostAnswers: 1, downAfterLost: true })
    const result = await agw(sandbox({ deploying: true }), host.url, deploy, {
      AGW_API_SECRET: host.secret,
      AGW_RESTART_WAIT_S: '2',
    })
    expect(result.code).toBe(7)
    const { error } = lastJson(result.stderr)
    expect(error.hint).toMatch(/^the run may have started; retry with --idempotency-key [0-9a-f-]{36}$/)
    expect(runs.size).toBe(1)
  })

  test('a 503 from a process that is up but not serving is retried the same way', async () => {
    const { runs, host, result } = await started({ refuseStarts: { count: 2, status: 503 } })
    expect(result.code).toBe(0)
    expect(starts(host)).toHaveLength(3)
    expect(runs.size).toBe(1)
  })

  test('a 500 is the request failing, not a restart: no retry, and the agent still gets the key to retry with', async () => {
    const host = await startFakeHost()
    try {
      const result = await agw(sandbox({ deploying: true }), host.url, ['fixture', 'boom'], {
        AGW_API_SECRET: host.secret,
      })
      expect(result.code).toBe(1)
      expect(lastJson(result.stderr).error.hint).toContain('the run may have started; retry with --idempotency-key')
      expect(host.requests.filter((r) => r.path === '/workflows/fixture/boom')).toHaveLength(1)
    } finally {
      await host.stop()
    }
  })
})
