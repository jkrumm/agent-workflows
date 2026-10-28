import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunExec } from '../src/workflows/check/exec.ts'

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
