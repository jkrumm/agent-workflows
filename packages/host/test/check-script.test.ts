import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectDead } from './support/process.ts'

// The agent path's idle watchdog: `agents/check/skills/run-step/run-step.sh`, a port of agent-gateway's run_step.
const script = join(import.meta.dir, '../../../agents/check/skills/run-step/run-step.sh')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-runstep-')))

async function runStep(idle: number, command: string, extra: { slot?: boolean; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(['sh', script, dir, String(idle), command, ...(extra.slot ? ['slot'] : [])], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...extra.env },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out, code }
}

describe('run-step.sh', () => {
  test('passes the exit code and output through, from the given directory', async () => {
    const ok = await runStep(5, 'pwd; echo err >&2')
    expect(ok.code).toBe(0)
    expect(ok.out).toContain(`${dir}\n`)
    expect(ok.out).toContain('err\n')
    expect(ok.out.trimEnd().split('\n').at(-1)).toBe('run-step: exit 0')
    const red = await runStep(5, 'echo bad; exit 3')
    expect(red.code).toBe(3)
    expect(red.out.trimEnd().split('\n').at(-1)).toBe('run-step: exit 3')
  })

  test('a silent command is killed alone after the idle window, with what it started', async () => {
    const started = Date.now()
    const hung = await runStep(2, `sleep 30 & echo $! > ${join(dir, 'child.pid')}; wait`)
    expect(hung.code).toBe(124)
    expect(hung.out.trimEnd().split('\n').at(-1)).toBe('run-step: IDLE_TIMEOUT no output for 2s')
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = Number(await Bun.file(join(dir, 'child.pid')).text())
    await expectDead(pid)
    // the next step is unaffected
    expect((await runStep(5, 'echo next')).code).toBe(0)
  }, 20_000)

  test('a slow command that keeps writing outlives the window', async () => {
    const slow = await runStep(3, 'i=0; while [ $i -lt 12 ]; do echo tick; sleep 0.5; i=$((i+1)); done') // 6 s against a 3 s window
    expect(slow.code).toBe(0)
    expect(slow.out).toContain('tick')
  }, 20_000)

  test('only the last 200 lines come back', async () => {
    const long = await runStep(5, 'i=0; while [ $i -lt 500 ]; do echo line-$i; i=$((i+1)); done')
    expect(long.out).toContain('line-499')
    expect(long.out).not.toContain('line-299\n')
  })

  describe('the factory test slot', () => {
    /** A `factory` on PATH that records its arguments and either runs the command after `--` or reports no slot. */
    function fakeFactory(behaviour: 'grant' | 'busy') {
      const bin = realpathSync(mkdtempSync(join(tmpdir(), 'agw-factory-')))
      const log = join(bin, 'calls.log')
      const body =
        behaviour === 'grant'
          ? `echo "$@" >> ${log}; echo "workers=$VITEST_MAX_WORKERS" >> ${log}; shift 4; shift; exec "$@"`
          : `echo "$@" >> ${log}; echo 'factory: no test slot within 1s; not running (set FACTORY_SLOT_OPEN=1 to run anyway)' >&2; exit 75`
      writeFileSync(join(bin, 'factory'), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, 'factory'), 0o755)
      return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => Bun.file(log).text() }
    }

    test('a slot step runs through `factory slot run`, named after the repo, with the workers capped to half the cores', async () => {
      const factory = fakeFactory('grant')
      const result = await runStep(5, 'echo hello', { slot: true, env: factory.env })
      expect(result.code).toBe(0)
      expect(result.out).toContain('hello')
      const calls = await factory.calls()
      expect(calls).toContain(`slot run --name agw-check:${dir.split('/').at(-1)} -- sh -c echo hello`)
      const cores = Number(new TextDecoder().decode(Bun.spawnSync(['getconf', '_NPROCESSORS_ONLN']).stdout))
      expect(calls).toContain(`workers=${Math.max(1, Math.floor(cores / 2))}`)
    })

    test('a step without `slot` never touches the factory', async () => {
      const factory = fakeFactory('grant')
      expect((await runStep(5, 'echo plain', { env: factory.env })).code).toBe(0)
      expect(await factory.calls().catch(() => '')).toBe('')
    })

    test('no slot within the wait is MACHINE_BUSY, exit 75, never a test failure', async () => {
      const busy = await runStep(5, 'bun test', { slot: true, env: fakeFactory('busy').env })
      expect(busy.code).toBe(75)
      expect(busy.out).toContain('no test slot within 1s')
      expect(busy.out.trimEnd().split('\n').at(-1)).toStartWith('run-step: MACHINE_BUSY')
    })

    test('a command that itself exits 75 is an ordinary red', async () => {
      const red = await runStep(5, 'exit 75', { slot: true, env: fakeFactory('grant').env })
      expect(red.code).toBe(75)
      expect(red.out.trimEnd().split('\n').at(-1)).toBe('run-step: exit 75')
    })

    test('the wait for a slot is silent and does not count against the idle window', async () => {
      const bin = realpathSync(mkdtempSync(join(tmpdir(), 'agw-factory-')))
      writeFileSync(join(bin, 'factory'), '#!/bin/sh\nsleep 3\nshift 4; shift; exec "$@"\n')
      chmodSync(join(bin, 'factory'), 0o755)
      const waited = await runStep(1, 'echo started', {
        slot: true,
        env: { PATH: `${bin}:${process.env.PATH}`, FACTORY_SLOT_WAIT_MS: '10000' },
      })
      expect(waited.code).toBe(0)
      expect(waited.out).toContain('started')
    }, 20_000)

    test('without `factory` on PATH a slot step runs as before', async () => {
      const bare = await runStep(5, 'echo bare', { slot: true, env: { PATH: '/usr/bin:/bin' } })
      expect(bare.code).toBe(0)
      expect(bare.out).toContain('bare')
    })
  })
})
