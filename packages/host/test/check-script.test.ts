import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The agent path's idle watchdog: `agents/check/skills/run-step/run-step.sh`, a port of agent-gateway's run_step.
const script = join(import.meta.dir, '../../../agents/check/skills/run-step/run-step.sh')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-runstep-')))

async function runStep(idle: number, command: string) {
  const proc = Bun.spawn(['sh', script, dir, String(idle), command], { stdout: 'pipe', stderr: 'pipe' })
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
    await Bun.sleep(300)
    expect(() => process.kill(pid, 0)).toThrow()
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
})
