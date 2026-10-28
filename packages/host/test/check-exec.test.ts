import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandEnv } from '../src/workflows/check/env.ts'
import { bunExec, createBunExec, drainStream } from '../src/workflows/check/exec.ts'

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agw-exec-')))
const sh = (script: string) => ['sh', '-c', script]

describe('bunExec', () => {
  test('exit code, merged stdout and stderr, PWD pinned to cwd', async () => {
    const result = await bunExec.run({ argv: sh('echo out; echo err >&2; echo "pwd=$PWD"; exit 3'), cwd })
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('out\n')
    expect(result.output).toContain('err\n')
    expect(result.output).toContain(`pwd=${cwd}\n`)
    expect(result).toMatchObject({ idleKilled: false, timedOut: false, aborted: false })
  })

  test('stderr can be discarded; the output is a bounded tail', async () => {
    const quiet = await bunExec.run({ argv: sh('echo out; echo err >&2'), cwd, stderr: 'discard' })
    expect(quiet.output).toBe('out\n')
    const long = await bunExec.run({
      argv: sh('i=0; while [ $i -lt 500 ]; do echo line-$i; i=$((i+1)); done'),
      cwd,
      tailChars: 100,
    })
    expect(long.output.length).toBe(100)
    expect(long.output.endsWith('line-499\n')).toBe(true)
  })

  test('a silent command is killed after the idle window, with its children', async () => {
    const pidFile = join(cwd, 'child.pid')
    const started = Date.now()
    const result = await bunExec.run({ argv: sh(`sleep 30 & echo $! > ${pidFile}; wait`), cwd, idleMs: 400 })
    expect(result.idleKilled).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow() // the backgrounded child is gone too
  })

  test('a slow but chatty command is not killed, however long it runs past the idle window', async () => {
    let chunks = 0
    const result = await bunExec.run({
      argv: sh('i=0; while [ $i -lt 8 ]; do echo tick; sleep 0.15; i=$((i+1)); done'),
      cwd,
      idleMs: 500,
      onOutput: () => chunks++,
    })
    expect(result).toMatchObject({ exitCode: 0, idleKilled: false })
    expect(chunks).toBeGreaterThanOrEqual(8)
  })

  test('an abort kills the command', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 200)
    const result = await bunExec.run({ argv: sh('sleep 30'), cwd, signal: controller.signal })
    expect(result.aborted).toBe(true)
    expect(await bunExec.run({ argv: sh('echo x'), cwd, signal: controller.signal })).toMatchObject({ aborted: true })
  })

  test('the wall cap is for helpers: it kills and says so', async () => {
    const result = await bunExec.run({ argv: sh('sleep 30'), cwd, wallMs: 200 })
    expect(result.timedOut).toBe(true)
  })

  test('a recipe’s orphan holding the pipes cannot wedge the step', async () => {
    const started = Date.now()
    const result = await bunExec.run({ argv: sh('sleep 30 & echo leader done'), cwd })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('leader done')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test('a command that cannot start is exit 127 with the reason', async () => {
    const result = await bunExec.run({ argv: ['agw-no-such-command'], cwd })
    expect(result.exitCode).toBe(127)
    expect(result.output).not.toBe('')
    expect(existsSync(cwd)).toBe(true)
  })
})

describe('credentials', () => {
  const env = {
    PATH: process.env.PATH,
    HOME: '/home/someone',
    LANG: 'C',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com',
    // the legacy list: anything credential-shaped
    CLAUDE_CODE_OAUTH_TOKEN: 'x',
    GH_TOKEN: 'x',
    MY_SECRET: 'x',
    DB_PASSWORD: 'x',
    SOME_API_KEY: 'x',
    AWS_SESSION_ID: 'x',
    // the host's own
    AGW_API_SECRET: 'x',
    AGW_PG_URL: 'postgres://user:pw@db.example.com/agw',
    AGW_PG_PASSWORD: 'x',
    IU_API_KEY: 'x',
    IU_BASE_URL: 'https://iu.example.com',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x=y',
    OTEL_EXPORTER_OTLP_AUTHORIZATION: 'x',
    ARGO_API_SECRET: 'x',
  }

  test('a command sees the host environment without credentials, PWD pinned', async () => {
    const result = await createBunExec({ env }).run({ argv: ['env'], cwd })
    const seen = result.output
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter(Boolean)
    for (const name of ['PATH', 'HOME', 'LANG', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'PWD']) expect(seen).toContain(name)
    const kept = ['PATH', 'HOME', 'LANG', 'OTEL_EXPORTER_OTLP_ENDPOINT']
    const credentials = Object.keys(env).filter((name) => !kept.includes(name))
    expect(seen.filter((name) => name !== undefined && credentials.includes(name))).toEqual([])
    expect(result.output).not.toContain('postgres://')
  })

  test('commandEnv drops exactly the credential-shaped names', () => {
    const kept = Object.keys(commandEnv(env, '/work')).sort()
    expect(kept).toEqual(['HOME', 'LANG', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'PATH', 'PWD'])
  })
})

describe('orphans of a crashed host', () => {
  const groupFile = () => join(mkdtempSync(join(tmpdir(), 'agw-groups-')), 'check', 'run_step.group')
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const startOf = (pid: number) =>
    Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
      .stdout.toString()
      .trim()
  const orphan = () => Bun.spawn(['sleep', '60'], { detached: true, stdout: 'ignore', stderr: 'ignore' })

  test('a recorded group that is still alive is killed before the next spawn', async () => {
    const file = groupFile()
    const left = orphan()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ pgid: left.pid, started: startOf(left.pid) }))
    const result = await bunExec.run({ argv: ['true'], cwd, groupFile: file })
    expect(result.exitCode).toBe(0)
    await left.exited
    expect(alive(left.pid)).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  test('a record whose pid was reused (other start time) kills nothing', async () => {
    const file = groupFile()
    const innocent = orphan()
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify({ pgid: innocent.pid, started: 'Mon Jan  1 00:00:00 2001' }))
      await bunExec.run({ argv: ['true'], cwd, groupFile: file })
      expect(alive(innocent.pid)).toBe(true)
      expect(existsSync(file)).toBe(false)
    } finally {
      innocent.kill('SIGKILL')
    }
  })

  test('the group is recorded while the command runs and the file is gone after it', async () => {
    const file = groupFile()
    const seen: string[] = []
    const running = bunExec.run({
      argv: sh('sleep 0.4'),
      cwd,
      groupFile: file,
    })
    await Bun.sleep(150)
    if (existsSync(file)) seen.push(readFileSync(file, 'utf8'))
    await running
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0] ?? '{}')).toMatchObject({ pgid: expect.any(Number), started: expect.any(String) })
    expect(existsSync(file)).toBe(false)
  })

  test('a garbage record is ignored', async () => {
    const file = groupFile()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{"pgid":')
    expect((await bunExec.run({ argv: ['true'], cwd, groupFile: file })).exitCode).toBe(0)
  })
})

describe('drainStream', () => {
  const bytes = (...chunks: number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
        controller.close()
      },
    })
  const text = async (stream: ReadableStream<Uint8Array>) => {
    let out = ''
    let chunks = 0
    await drainStream(
      stream,
      () => chunks++,
      (piece) => {
        out += piece
      },
    )
    return { out, chunks }
  }

  test('reads to the end, one onChunk per chunk', async () => {
    const encoder = new TextEncoder()
    expect(await text(bytes([...encoder.encode('ab')], [...encoder.encode('cd')]))).toEqual({ out: 'abcd', chunks: 2 })
  })

  test('a read that rejects is the end of the stream: it resolves, keeping what arrived', async () => {
    let sent = false
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error('pipe torn down')
        sent = true
        controller.enqueue(new TextEncoder().encode('before'))
      },
    })
    expect(await text(broken)).toEqual({ out: 'before', chunks: 1 })
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('boom'))
      },
    })
    expect(await text(failing)).toEqual({ out: '', chunks: 0 })
  })

  test('the decoder is flushed at the end: a character cut by the last chunk is not dropped silently', async () => {
    const { out } = await text(bytes([0x6f, 0x6b, 0xe2, 0x82]))
    expect(out).toBe('ok\uFFFD')
    expect((await text(bytes([0xe2, 0x82], [0xac]))).out).toBe('€') // split across chunks, still whole
  })

  test('without a text sink it still drains, so the child never blocks on a full pipe', async () => {
    let chunks = 0
    await drainStream(bytes([1], [2], [3]), () => chunks++)
    expect(chunks).toBe(3)
  })
})
