import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { InfraError, WorkflowError } from '@agent-workflows/runtime'
import { registerFonts } from '../src/workflows/diagram/dom-shim.ts'
import { childHydrate, limiter, processHydrate } from '../src/workflows/diagram/hydrate.ts'
import { EXIT_DEADLINE, EXIT_ORPHANED, startWatchdog } from '../src/workflows/diagram/watchdog.ts'
import { rejection } from './support.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const never = () => new AbortController().signal
const rect = {
  type: 'rectangle',
  id: 'r',
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  label: { text: 'HTTPS / JSON', fontSize: 20 },
}

describe('hydration child process', () => {
  test('converts in a child, with the app’s label widths even under a test runner', async () => {
    const result = await processHydrate([rect], never())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const label = result.file.elements.find((e) => e.type === 'text')
    // 150.76 px in the app's Excalifont at 20 px; ×10 if the library thought it ran under a test runner
    expect(label?.width).toBeCloseTo(150.76, 1)
    expect(result.file.source).toBe('https://excalidraw.com')
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
  }, 20_000)

  test('a skeleton the library throws on is the agent’s mistake, not an infra error', async () => {
    const result = await processHydrate([null], never())
    expect(result.ok).toBe(false)
  }, 20_000)

  // SIGKILL stands for the OOM killer. Not SIGSEGV: on a Linux host whose core_pattern is apport (GitHub's runners), the
  // kernel writes a core dump before the process is reaped, 12-17 s in which the child is a zombie that has not "exited".
  test('a crash, a kill, a silent exit and garbage are infra errors of the exit kind, never the timeout kind', async () => {
    for (const [script, message] of [
      ['process.exit(3)', /exited with 3/],
      ['process.kill(process.pid, "SIGKILL")', /SIGKILL/],
      ['process.exit(0)', /not a document/],
      ['console.log("not json"); process.exit(0)', /not a document/],
      [
        'console.log(JSON.stringify({ok:true,document:"{\\"type\\":\\"nope\\"}"})); process.exit(0)',
        /unexpected hydration output/,
      ],
    ] as const) {
      // The timeout is far above the test's own: a child waited on until the deadline would be a `timeout` failure
      // (a WorkflowError), so an InfraError that carries the exit kind proves the exit itself was seen.
      const hydrate = childHydrate({ command: [process.execPath, '-e', script], timeoutMs: 25_000 })
      const error = await hydrate([rect], never()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(InfraError)
      expect((error as Error).message).toMatch(message)
      expect((error as Error).message).not.toContain('timed out')
    }
  }, 28_000)

  test('a hung child is killed by its PID on timeout and on abort', async () => {
    const pids: number[] = []
    const hang = {
      command: [process.execPath, '-e', 'await Bun.sleep(60000)'],
      onSpawn: (pid: number) => pids.push(pid),
    }
    expect(await rejection(childHydrate({ ...hang, timeoutMs: 300 })([rect], never()))).toMatch(/timed out/)
    const controller = new AbortController()
    const aborted = childHydrate({ ...hang, timeoutMs: 20_000 })([rect], controller.signal)
    setTimeout(() => controller.abort(new Error('cancelled')), 200)
    expect(await rejection(aborted)).toContain('cancelled')
    expect(pids).toHaveLength(2)
    await Bun.sleep(100)
    for (const pid of pids) expect(alive(pid)).toBe(false)
  }, 20_000)

  test('an already aborted signal spawns nothing', async () => {
    const pids: number[] = []
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const hydrate = childHydrate({ command: [process.execPath, '-e', '0'], onSpawn: (pid) => pids.push(pid) })
    expect(await rejection(hydrate([rect], controller.signal))).toContain('stop')
    expect(pids).toEqual([])
  })
})

describe('concurrency cap', () => {
  test('at most the limit run at once, the rest queue in order', async () => {
    const limited = limiter(2)
    let running = 0
    let peak = 0
    const order: number[] = []
    const job = (n: number) =>
      limited(never(), async () => {
        order.push(n)
        peak = Math.max(peak, ++running)
        await Bun.sleep(30)
        running--
        return n
      })
    expect(await Promise.all([1, 2, 3, 4, 5].map(job))).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  test('a queued call that aborts leaves the queue and frees nothing it never held', async () => {
    const limited = limiter(1)
    const release = Promise.withResolvers<void>()
    const first = limited(never(), () => release.promise)
    const controller = new AbortController()
    const queued = limited(controller.signal, async () => 'never')
    controller.abort(new Error('gone'))
    expect(await rejection(queued)).toContain('gone')
    const third = limited(never(), async () => 'third')
    release.resolve()
    await first
    expect(await third).toBe('third')
    // the slot is free again
    expect(await limited(never(), async () => 'after')).toBe('after')
  })

  test('the real hydrator runs 4 calls through the cap of 2', async () => {
    const running = new Set<number>()
    let peak = 0
    const hydrate = childHydrate({
      maxConcurrent: 2,
      onSpawn: (pid) => {
        running.add(pid)
        peak = Math.max(peak, [...running].filter((p) => alive(p)).length)
      },
    })
    const results = await Promise.all([1, 2, 3, 4].map(() => hydrate([rect], never())))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(peak).toBeLessThanOrEqual(2)
  }, 30_000)
})

describe('limiter abort races', () => {
  test('an abort landing at any point between the hand-over and the resume never releases a slot twice', async () => {
    for (let ticks = 0; ticks <= 8; ticks++) {
      const limited = limiter(1)
      const hold = Promise.withResolvers<void>()
      const first = limited(never(), () => hold.promise)
      const controller = new AbortController()
      let startedAfterAbort = false
      const queued = limited(controller.signal, async () => {
        startedAfterAbort = controller.signal.aborted
        return 'ran'
      }).catch((e: unknown) => e)
      // the holder finishes: its slot goes to the waiter; the abort lands `ticks` microtasks later
      hold.resolve()
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      controller.abort(new Error('cancelled'))
      await first
      await queued
      // an aborted call never starts its work, wherever the abort landed
      expect(startedAfterAbort).toBe(false)
      // the cap must still be exactly 1: a double release would let two of these run at once
      let running = 0
      let peak = 0
      const job = () =>
        limited(never(), async () => {
          peak = Math.max(peak, ++running)
          await Bun.sleep(5)
          running--
        })
      await Promise.all([job(), job(), job()])
      expect(peak).toBe(1)
    }
  })
})

describe('font registration', () => {
  test('a family that registers no file throws instead of measuring in a fallback font', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-fonts-'))
    try {
      mkdirSync(join(dir, 'Excalifont'))
      writeFileSync(join(dir, 'Excalifont', 'not-a-font.woff2'), 'nope')
      expect(() => registerFonts(dir)).toThrow(/font family Excalifont: no font file registered/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const DIAGRAM_SRC = resolve(import.meta.dir, '../src/workflows/diagram')

describe('child ownership of errors', () => {
  test('a setup failure exits non-zero with the error on stderr, never an { ok: false } reply', async () => {
    const proc = Bun.spawn([process.execPath, join(DIAGRAM_SRC, 'hydrate-child.ts')], {
      stdin: Buffer.from('this is not json'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('hydration setup failed')
  }, 20_000)

  test('a child that cannot run is an InfraError, a timeout is a non-retried timeout failure', async () => {
    const crash = childHydrate({ command: [process.execPath, '-e', 'process.exit(1)'] })
    expect(await crash([rect], never()).catch((e: unknown) => e)).toBeInstanceOf(InfraError)
    const hang = childHydrate({ command: [process.execPath, '-e', 'await Bun.sleep(60000)'], timeoutMs: 200 })
    const timeout = await hang([rect], never()).catch((e: unknown) => e)
    expect(timeout).toBeInstanceOf(WorkflowError)
    expect(timeout).not.toBeInstanceOf(InfraError)
    expect((timeout as WorkflowError).kind).toBe('timeout')
  }, 20_000)
})

describe('watchdog', () => {
  test('exits at its deadline, and when the parent changes', async () => {
    const codes: number[] = []
    const stop = startWatchdog({ deadlineMs: 60, pollMs: 10, parentPid: () => 1234, exit: (c) => codes.push(c) })
    await Bun.sleep(150)
    stop()
    expect(codes).toEqual([EXIT_DEADLINE])

    let parent = 1234
    const orphaned: number[] = []
    const stop2 = startWatchdog({
      deadlineMs: 60_000,
      pollMs: 10,
      parentPid: () => parent,
      exit: (c) => orphaned.push(c),
    })
    await Bun.sleep(40)
    expect(orphaned).toEqual([])
    parent = 1
    await Bun.sleep(60)
    stop2()
    expect(orphaned[0]).toBe(EXIT_ORPHANED)
  })

  test('the real child ends itself at its deadline when the host never closes its stdin', async () => {
    const proc = Bun.spawn([process.execPath, join(DIAGRAM_SRC, 'hydrate-child.ts')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '', AGW_HYDRATE_DEADLINE_MS: '800' },
    })
    // the exit code is the proof: it can only be the deadline's, the host never closes stdin and never kills this child
    expect(await proc.exited).toBe(EXIT_DEADLINE)
  }, 20_000)
})

describe('limits on a call', () => {
  test('a wait for a slot over the queue limit is a timeout; the holder is unaffected', async () => {
    const pids: number[] = []
    const holder = new AbortController()
    const hydrate = childHydrate({
      command: [process.execPath, '-e', 'await Bun.sleep(60000)'],
      maxConcurrent: 1,
      timeoutMs: 20_000,
      queueWaitMs: 300,
      onSpawn: (pid) => pids.push(pid),
    })
    const first = hydrate([rect], holder.signal).catch((e: unknown) => e)
    const second = await hydrate([rect], never()).catch((e: unknown) => e)
    expect(second).toBeInstanceOf(WorkflowError)
    expect((second as WorkflowError).message).toContain('waited over 300 ms for a slot')
    expect(pids).toHaveLength(1)
    holder.abort(new Error('done'))
    expect(((await first) as Error).message).toBe('done')
  }, 20_000)

  test('a child that floods stdout is cut at the cap, and stderr is read but only its tail is kept', async () => {
    const flood = childHydrate({
      command: [process.execPath, '-e', 'process.stdout.write("x".repeat(500000))'],
      maxReplyBytes: 1024,
    })
    const error = await flood([rect], never()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InfraError)
    expect((error as Error).message).toContain('over 1024 bytes')
    const noisy = childHydrate({
      command: [process.execPath, '-e', 'await Bun.write(Bun.stderr, "e".repeat(2000000)+"TAIL"); process.exit(3)'],
    })
    const failure = (await noisy([rect], never()).catch((e: unknown) => e)) as Error
    expect(failure.message).toContain('exited with 3')
    expect(failure.message.endsWith('TAIL')).toBe(true)
    expect(failure.message.length).toBeLessThan(5_000)
  }, 20_000)
})

describe('a release-like tree', () => {
  test('the real child runs from a copied tree, from its package dir, with only PATH, HOME, TMPDIR and its own variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-release-'))
    try {
      const dir = join(root, 'packages', 'host', 'src', 'workflows', 'diagram')
      mkdirSync(dir, { recursive: true })
      for (const file of ['hydrate-child.ts', 'dom-shim.ts', 'watchdog.ts'])
        copyFileSync(join(DIAGRAM_SRC, file), join(dir, file))
      symlinkSync(resolve(import.meta.dir, '../node_modules'), join(root, 'packages', 'host', 'node_modules'))
      process.env.AGW_TEST_SECRET = 'must-not-reach-the-child'
      // a bunfig and a .env in a cwd the child must not use would change its behaviour
      writeFileSync(join(root, '.env'), 'NODE_ENV=development\n')
      const copied = join(dir, 'hydrate-child.ts')
      const result = await childHydrate({ script: copied })([rect], never())
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.file.elements.find((e) => e.type === 'text')?.width).toBeCloseTo(150.76, 1)

      // what the child is given: probe it with the same spawn options and a command that reports them
      const probe = childHydrate({
        script: copied,
        command: [
          process.execPath,
          '-e',
          'console.log(JSON.stringify({ ok: false, error: JSON.stringify({ cwd: process.cwd(), env: Object.keys(process.env).sort() }) }))',
        ],
      })
      const answer = await probe([rect], never())
      expect(answer.ok).toBe(false)
      const seen = JSON.parse(answer.ok ? '{}' : answer.error) as { cwd: string; env: string[] }
      expect(seen.cwd.endsWith(join('packages', 'host'))).toBe(true)
      expect(
        seen.env.filter(
          (k) =>
            !['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'AGW_HYDRATE_DEADLINE_MS', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(
              k,
            ),
        ),
      ).toEqual([])
      expect(seen.env).not.toContain('AGW_TEST_SECRET')
    } finally {
      delete process.env.AGW_TEST_SECRET
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
