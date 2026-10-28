import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createCheckWorkflows } from '../src/workflows/check/index.ts'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'

// No fakes except the agent host: real `git`, real `make`, the default `Bun.spawn` exec port.
const db = freshSchema('checkreal')
const stateDir = mkdtempSync(join(tmpdir(), 'agw-check-state-'))

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await db.drop()
})

function repo(makefile: string) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agw-check-real-')))
  const git = Bun.spawnSync(['git', 'init', '--quiet'], { cwd })
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`)
  writeFileSync(join(cwd, 'Makefile'), makefile)
  return cwd
}

async function run(input: Record<string, unknown>, host?: FakeAgentHost) {
  const workflow = createCheckWorkflows({ stateDir })[0]?.workflow
  if (!workflow) throw new Error('no check workflow')
  const rt = testRuntime({ schema: db.schema, workflows: [workflow], host })
  await rt.open()
  try {
    const { runId } = await rt.start(workflow, input, { purpose: 'build' })
    return await rt.wait(runId)
  } finally {
    await rt.close()
  }
}

test('a green Makefile check runs make check in the repo, no agent', async () => {
  const cwd = repo('check:\n\t@echo validating\n')
  const host = new FakeAgentHost()
  const result = await run({ cwd }, host)
  expect(result.output).toEqual({
    passed: true,
    steps: [{ name: 'check', passed: true }],
    summary: 'make check passed',
  })
  expect(host.events).toEqual([])
})

test('a red Makefile check reports its output lines, run in the repo’s own directory', async () => {
  const cwd = repo('check:\n\t@echo "pwd=$$PWD"\n\t@echo "lint: 2 errors" >&2\n\t@exit 1\n')
  const result = await run({ cwd })
  expect(result.output).toEqual({
    passed: false,
    steps: [{ name: 'check', passed: false, errors: expect.arrayContaining([`pwd=${cwd}`, 'lint: 2 errors']) }],
    summary: 'make check failed (exit 2)',
  } as never)
})

test('a Makefile with only check-foo is not a contract: the agent takes over', async () => {
  const cwd = repo('check-foo:\n\t@exit 1\n')
  const green = { passed: true, steps: [], summary: 'no validation steps were found' }
  const host = new FakeAgentHost(async () => ({ output: green }))
  const result = await run({ cwd }, host)
  expect(result.output).toEqual(green)
  expect(host.sessions.size).toBe(1)
})

test('a directory that is not a git work tree is refused', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agw-check-plain-')))
  writeFileSync(join(cwd, 'Makefile'), 'check:\n\t@true\n')
  const result = await run({ cwd })
  expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
})

test('the idle watchdog kills a silent make check after stepTimeoutSeconds', async () => {
  const cwd = repo('check:\n\t@sleep 30\n')
  const started = Date.now()
  const result = await run({ cwd, stepTimeoutSeconds: 1 })
  expect(Date.now() - started).toBeLessThan(10_000)
  const output = result.output as { passed: boolean; steps: { name: string; errors: string[] }[]; summary: string }
  expect(output.passed).toBe(false)
  expect(output.steps[0]?.name).toBe('check')
  expect(output.steps[0]?.errors[0]).toBe('no output for 1s — likely a watch-mode runner or a hung process')
  expect(output.summary).toBe('make check failed: no output for 1s')
})

test('a slow chatty make check outlives its idle window and passes', async () => {
  // ~3 s of runtime against a 1 s window, one line every 0.3 s
  const cwd = repo('check:\n\t@i=0; while [ $$i -lt 10 ]; do echo tick; sleep 0.3; i=$$((i+1)); done\n')
  const result = await run({ cwd, stepTimeoutSeconds: 1 })
  expect(result.output).toEqual({
    passed: true,
    steps: [{ name: 'check', passed: true }],
    summary: 'make check passed',
  })
})

test('credentials of the host never reach make check or the make -p -q probe', async () => {
  const names = ['AGW_API_SECRET', 'AGW_PG_URL', 'IU_API_KEY', 'OTEL_EXPORTER_OTLP_HEADERS', 'GH_TOKEN']
  const saved = names.map((name) => [name, process.env[name]] as const)
  for (const name of names) process.env[name] = `leak-${name}`
  try {
    const probeFile = join(realpathSync(mkdtempSync(join(tmpdir(), 'agw-probe-'))), 'probe-env')
    // `:=` runs the $(shell …) while make reads the Makefile, i.e. during `make -p -q`, and again for `make check`
    const cwd = repo(
      `PROBED := $(shell env > ${probeFile})\ncheck:\n\t@env | grep -E 'AGW_|IU_|OTEL_|GH_' || true\n\t@echo "path-set=$$(test -n \"$$PATH\" && echo yes)"\n\t@exit 1\n`,
    )
    const result = await run({ cwd })
    const output = result.output as { steps: { errors: string[] }[] }
    expect(output.steps[0]?.errors[0]).toBe('path-set=yes') // nothing the grep matched came before it
    const probed = await Bun.file(probeFile).text()
    expect(probed).toContain('PATH=')
    for (const name of names) expect(probed).not.toContain(name)
    expect(JSON.stringify(result)).not.toContain('leak-')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
