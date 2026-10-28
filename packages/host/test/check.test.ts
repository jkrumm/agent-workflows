import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createCheckWorkflows } from '../src/workflows/check/index.ts'
import type { Exec, ExecRequest, ExecResult } from '../src/workflows/check/exec.ts'
import { makeDatabaseHasCheckTarget } from '../src/workflows/check/make.ts'
import { JSON_ONLY_RETRY } from '../src/workflows/check/prompt.ts'
import { freshSchema, inspector, testRuntime, until } from '../../runtime/test/support/pg.ts'
import { startTestHost } from './support.ts'

const db = freshSchema('check')
const sql = inspector(db.schema)

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await sql.close()
  await db.drop()
})

const dbWith = (header: string, recipe = true) =>
  [
    '# GNU Make',
    '# Variables',
    'check = nope',
    '# Files',
    '',
    header,
    ...(recipe ? ["#  recipe to execute (from `Makefile', line 3):", '\t@true'] : []),
    '',
    '# files hash-table stats:',
  ].join('\n')

const OK: ExecResult = {
  exitCode: 0,
  signalCode: null,
  output: '',
  truncated: false,
  idleKilled: false,
  timedOut: false,
  aborted: false,
}

/** A scripted exec port: `handler` answers a command, git and make probes have sensible defaults. */
function fakeExec(
  handler: (request: ExecRequest) => Partial<ExecResult> | undefined | Promise<Partial<ExecResult> | undefined>,
  installed: string[] = ['make'],
) {
  const calls: ExecRequest[] = []
  const exec: Exec = {
    which: (command) => (installed.includes(command) ? `/usr/bin/${command}` : null),
    async run(request) {
      calls.push(request)
      const answer = await handler(request)
      if (answer) return { ...OK, ...answer }
      const [command, ...rest] = request.argv
      if (command === 'git' && rest[0] === 'rev-parse') return { ...OK, output: 'true\n' }
      if (command === 'git' && rest[0] === 'remote') return { ...OK, output: 'origin\n' }
      if (command === 'make' && rest[0] === '-p') return { ...OK, output: dbWith('check: lint test') }
      return OK
    },
  }
  return { exec, calls, ran: (...argv: string[]) => calls.filter((c) => c.argv.join(' ') === argv.join(' ')).length }
}

function repo(makefile = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'agw-check-'))
  if (makefile) writeFileSync(join(cwd, 'Makefile'), 'check:\n\t@true\n')
  return cwd
}

function checkWorkflow(exec: Exec, logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }) {
  const entry = createCheckWorkflows({ exec, stateDir: tmpdir(), logger })[0]
  if (!entry) throw new Error('no check workflow')
  return entry.workflow
}

const GREEN = { passed: true, steps: [{ name: 'lint', passed: true }], summary: 'All 1 steps passed' }

async function run(options: {
  exec: Exec
  host?: FakeAgentHost
  input: Record<string, unknown>
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
}) {
  const workflow = checkWorkflow(options.exec, options.logger)
  const rt = testRuntime({ schema: db.schema, workflows: [workflow], host: options.host })
  await rt.open()
  try {
    const { runId } = await rt.start(workflow, options.input, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}

describe('Makefile path', () => {
  test('a passing make check is one code step, no agent, no tokens', async () => {
    const cwd = repo()
    const host = new FakeAgentHost()
    const { exec, ran } = fakeExec(() => undefined)
    const { runId, result } = await run({ exec, host, input: { cwd } })
    expect(result.status).toBe('done')
    expect(result.output).toEqual({
      passed: true,
      steps: [{ name: 'check', passed: true }],
      summary: 'make check passed',
    })
    expect(host.events).toEqual([])
    expect(ran('make', 'check')).toBe(1)
    expect((await sql.steps(runId)).map((s) => [s.step_id, s.kind])).toEqual([
      ['plan', 'code'],
      ['make-check', 'code'],
    ])
  })

  test('a failing make check fills errors from the output tail, bounded per line and in count', async () => {
    const cwd = repo()
    const lines = Array.from({ length: 80 }, (_, i) => (i === 79 ? `last ${'x'.repeat(600)}` : `line ${i}`))
    const { exec } = fakeExec((request) =>
      request.argv[0] === 'make' && request.argv[1] === 'check'
        ? { exitCode: 2, output: `${lines.join('\n')}\n\n` }
        : undefined,
    )
    const { result } = await run({ exec, input: { cwd } })
    const output = result.output as { passed: boolean; steps: { errors: string[] }[]; summary: string }
    expect(output.passed).toBe(false)
    expect(output.summary).toBe('make check failed (exit 2)')
    const { errors } = output.steps[0] as { errors: string[] }
    expect(errors).toHaveLength(50)
    expect(errors[0]).toBe('line 30')
    expect(errors.at(-1)).toBe(`last ${'x'.repeat(495)}…`)
  })

  test('a failure with no output still says why; an idle kill says so', async () => {
    const cwd = repo()
    const silent = fakeExec((r) => (r.argv[1] === 'check' ? { exitCode: 1 } : undefined))
    const a = await run({ exec: silent.exec, input: { cwd } })
    expect((a.result.output as { steps: { errors: string[] }[] }).steps[0]?.errors).toEqual([
      'make check failed (exit 1) with no output',
    ])
    const idle = fakeExec((r) =>
      r.argv[1] === 'check' ? { exitCode: null, idleKilled: true, output: 'tail\n' } : undefined,
    )
    const b = await run({ exec: idle.exec, input: { cwd, stepTimeoutSeconds: 7 } })
    expect(b.result.output).toEqual({
      passed: false,
      steps: [
        {
          name: 'check',
          passed: false,
          errors: ['no output for 7s — likely a watch-mode runner or a hung process', 'tail'],
        },
      ],
      summary: 'make check failed: no output for 7s',
    })
  })

  test('the idle window is 600 s for make check by default, the caller’s when given; the runtime timer sits above it', async () => {
    const cwd = repo()
    const a = fakeExec(() => undefined)
    await run({ exec: a.exec, input: { cwd } })
    const make = a.calls.find((c) => c.argv[1] === 'check')
    expect(make?.idleMs).toBe(600_000)
    expect(make?.cwd).toBe(cwd)
    expect(make?.onOutput).toBeFunction()
    const b = fakeExec(() => undefined)
    await run({ exec: b.exec, input: { cwd, stepTimeoutSeconds: 30 } })
    expect(b.calls.find((c) => c.argv[1] === 'check')?.idleMs).toBe(30_000)
  })

  test('fallow runs after make check when installed and the repo has a remote, even after a red make check', async () => {
    const cwd = repo()
    const { exec, calls } = fakeExec(
      (r) => (r.argv[0] === 'make' && r.argv[1] === 'check' ? { exitCode: 1, output: 'boom' } : undefined),
      ['make', 'fallow'],
    )
    const { result } = await run({ exec, input: { cwd } })
    expect(result.output).toEqual({
      passed: false,
      steps: [
        { name: 'check', passed: false, errors: ['boom'] },
        { name: 'fallow', passed: true },
      ],
      summary: 'make check failed (exit 1); fallow audit --quiet passed',
    })
    expect(calls.filter((c) => c.argv[0] === 'fallow').map((c) => c.argv)).toEqual([['fallow', 'audit', '--quiet']])
  })

  test('fallow is skipped without a remote, and when not installed', async () => {
    const cwd = repo()
    const noRemote = fakeExec(
      (r) => (r.argv[0] === 'git' && r.argv[1] === 'remote' ? { output: '\n' } : undefined),
      ['make', 'fallow'],
    )
    const a = await run({ exec: noRemote.exec, input: { cwd } })
    expect((a.result.output as { steps: unknown[] }).steps).toEqual([{ name: 'check', passed: true }])
    expect(noRemote.calls.some((c) => c.argv[0] === 'fallow')).toBe(false)
    const notInstalled = fakeExec(() => undefined)
    const b = await run({ exec: notInstalled.exec, input: { cwd } })
    expect((b.result.output as { steps: unknown[] }).steps).toHaveLength(1)
    expect(notInstalled.ran('git', 'remote')).toBe(0)
  })

  test('a target named check-foo only is not a check: target; the agent runs', async () => {
    const cwd = repo()
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    const { exec } = fakeExec((r) =>
      r.argv[0] === 'make' && r.argv[1] === '-p' ? { output: dbWith('check-foo:') } : undefined,
    )
    const { result } = await run({ exec, host, input: { cwd } })
    expect(result.output).toEqual(GREEN)
    expect(host.events.map((e) => e.op)).toEqual(['open', 'prompt'])
    expect(host.sessions.get('ses_1')?.spec.prompt).toContain('Mode: DISCOVER.')
  })

  test('no Makefile, or no make, goes straight to the agent without probing', async () => {
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    const none = fakeExec(() => undefined)
    await run({ exec: none.exec, host, input: { cwd: repo(false) } })
    expect(none.calls.some((c) => c.argv[0] === 'make')).toBe(false)
    const noMake = fakeExec(() => undefined, [])
    await run({ exec: noMake.exec, host, input: { cwd: repo() } })
    expect(noMake.calls.some((c) => c.argv[0] === 'make')).toBe(false)
  })
})

describe('parsing the make database', () => {
  test('only a real check rule counts', () => {
    expect(makeDatabaseHasCheckTarget(dbWith('check: lint test', false))).toBe(true)
    expect(makeDatabaseHasCheckTarget(dbWith('check::', true))).toBe(true)
    expect(makeDatabaseHasCheckTarget(dbWith('check:', true))).toBe(true)
    expect(makeDatabaseHasCheckTarget(dbWith('check:', false))).toBe(false) // empty rule: "Nothing to be done"
    expect(makeDatabaseHasCheckTarget(dbWith('check-foo: bar'))).toBe(false)
    expect(makeDatabaseHasCheckTarget(dbWith('# Not a target:\ncheck:'))).toBe(false) // a file or directory named check
    expect(makeDatabaseHasCheckTarget('# Implicit Rules\n%:\n')).toBe(false)
    expect(makeDatabaseHasCheckTarget('')).toBe(false)
  })
})

describe('agent path', () => {
  test('explicit commands: exactly those commands in the prompt, the checked tree allowed, no Makefile probe', async () => {
    const cwd = repo()
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    const { exec, calls } = fakeExec(() => undefined, ['make', 'fallow'])
    const commands = ['.venv/bin/ruff check', '.venv/bin/pytest -q']
    const { runId, result } = await run({ exec, host, input: { cwd, commands, stepTimeoutSeconds: 90 } })
    expect(result.output).toEqual(GREEN)
    const session = host.sessions.get('ses_1')
    expect(session?.spec.agent).toBe('check')
    expect(session?.spec.options).toEqual({ output: 'json', allowDirectories: [cwd] })
    const prompt = session?.spec.prompt ?? ''
    expect(prompt).toContain(`Working directory: ${cwd}`)
    expect(prompt).toContain('Mode: COMMANDS.')
    expect(prompt).toContain('1. `.venv/bin/ruff check`\n2. `.venv/bin/pytest -q`')
    expect(prompt).not.toContain('DISCOVER')
    expect(calls.some((c) => c.argv[0] === 'make' || c.argv[0] === 'fallow')).toBe(false)
    expect((await sql.steps(runId)).map((s) => s.step_id)).toEqual(['plan', 'agent'])
  })

  test('the agent step waits out the longest step window: idle above 600 s + margin by default', async () => {
    const cwd = repo(false)
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    const { runId } = await run({ exec: fakeExec(() => undefined).exec, host, input: { cwd } })
    expect(host.sessions.get('ses_1')?.spec.prompt).toContain('kills the session after 720s')
    expect((await sql.step(runId, 'agent'))?.status).toBe('done')
  })

  test('invalid JSON: one retry with the JSON-only directive in a fresh session', async () => {
    const cwd = repo(false)
    let n = 0
    const host = new FakeAgentHost(async () => ({ output: ++n === 1 ? 'Looks fine to me' : GREEN }))
    const { runId, result } = await run({ exec: fakeExec(() => undefined).exec, host, input: { cwd } })
    expect(result.output).toEqual(GREEN)
    const [first, second] = [host.sessions.get('ses_1'), host.sessions.get('ses_2')]
    expect(second?.spec.prompt).toBe(first?.spec.prompt + JSON_ONLY_RETRY)
    expect(JSON_ONLY_RETRY).not.toContain('again') // the retry is a new session: running the steps again is expected
    expect((await sql.steps(runId)).map((s) => [s.step_id, s.status])).toEqual([
      ['plan', 'done'],
      ['agent', 'failed'],
      ['agent-retry', 'done'],
    ])
  })

  test('invalid JSON twice: passed false with a summary, the run is done, not crashed', async () => {
    const cwd = repo(false)
    const host = new FakeAgentHost(async () => ({ output: { passed: 'maybe' } }))
    const { result } = await run({ exec: fakeExec(() => undefined).exec, host, input: { cwd } })
    expect(result.status).toBe('done')
    const output = result.output as { passed: boolean; steps: unknown[]; summary: string }
    expect(output).toMatchObject({ passed: false, steps: [] })
    expect(output.summary).toStartWith('check agent returned invalid output twice')
    expect(host.sessions.size).toBe(2)
  })

  test('any non-empty step name is accepted, an empty one is invalid output', async () => {
    const cwd = repo(false)
    const named = { passed: true, steps: [{ name: 'ruff', passed: true }], summary: 's' }
    const ok = await run({
      exec: fakeExec(() => undefined).exec,
      host: new FakeAgentHost(async () => ({ output: named })),
      input: { cwd },
    })
    expect(ok.result.output).toEqual(named)
    const host = new FakeAgentHost(async () => ({ output: { ...named, steps: [{ name: '', passed: true }] } }))
    const bad = await run({ exec: fakeExec(() => undefined).exec, host, input: { cwd } })
    expect((bad.result.output as { passed: boolean }).passed).toBe(false)
    expect(host.sessions.size).toBe(2)
  })

  test('the prompt carries the idle windows and the run-step wrapper is in the agent', async () => {
    const cwd = repo(false)
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    await run({ exec: fakeExec(() => undefined).exec, host, input: { cwd, stepTimeoutSeconds: 45 } })
    expect(host.sessions.get('ses_1')?.spec.prompt).toContain('45s for ordinary steps, 45s for the test step')
    const agentsMd = readFileSync(join(import.meta.dir, '../../../agents/check/AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('.opencode/skills/run-step/run-step.sh')
  })
})

describe('input', () => {
  test('a relative cwd, an unknown key and a bad timeout are refused at start', async () => {
    const workflow = checkWorkflow(fakeExec(() => undefined).exec)
    const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
    await rt.open()
    try {
      for (const input of [
        { cwd: 'relative/dir' },
        { cwd: '/tmp', extra: 1 },
        { cwd: '/tmp', stepTimeoutSeconds: 0 },
        {},
      ]) {
        const error = await rt.start(workflow, input, { purpose: 'build' }).catch((e: unknown) => e)
        expect(error).toMatchObject({ kind: 'invalid_input' })
      }
    } finally {
      await rt.close()
    }
  })

  test('a directory that is not a git work tree, and one that does not exist, end the run as invalid_input', async () => {
    const notGit = fakeExec((r) =>
      r.argv[0] === 'git'
        ? { exitCode: 128, output: 'fatal: not a git repository (or any of the parent directories): .git\n' }
        : undefined,
    )
    const a = await run({ exec: notGit.exec, input: { cwd: repo() } })
    expect(a.result).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
    expect(a.result.error?.message).toContain('not a git work tree')
    expect(notGit.calls.some((c) => c.argv[0] === 'make')).toBe(false)
    const b = await run({ exec: fakeExec(() => undefined).exec, input: { cwd: join(tmpdir(), 'agw-check-nope') } })
    expect(b.result).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
    expect(b.result.error?.message).toContain('does not exist')
  })
})

describe('probes and kills', () => {
  test('a git probe that fails for any other reason is retried and never journaled as a refusal', async () => {
    const flaky = fakeExec((r) =>
      r.argv[0] === 'git' && r.argv[1] === 'rev-parse'
        ? { exitCode: 1, output: 'fatal: unable to access the repository\n' }
        : undefined,
    )
    const { runId, result } = await run({ exec: flaky.exec, input: { cwd: repo() } })
    expect(result.status).toBe('failed')
    expect(result.error?.kind).not.toBe('invalid_input')
    expect(flaky.ran('git', 'rev-parse', '--is-inside-work-tree')).toBe(3)
    expect((await sql.step(runId, 'plan'))?.status).toBe('failed')

    // ... and a probe that recovers on the retry carries on
    let calls = 0
    const recovering = fakeExec((r) =>
      r.argv[0] === 'git' && r.argv[1] === 'rev-parse' && ++calls === 1 ? { exitCode: 1, output: 'busy' } : undefined,
    )
    const second = await run({ exec: recovering.exec, input: { cwd: repo() } })
    expect(second.result).toMatchObject({ status: 'done', output: { passed: true } })
  })

  test('every probe gets the step signal; the make probe has 30 s and keeps the whole output', async () => {
    const { exec, calls } = fakeExec(() => undefined, ['make', 'fallow'])
    await run({ exec, input: { cwd: repo() } })
    const probes = calls.filter((c) => c.wallMs !== undefined)
    expect(probes.map((c) => c.argv.slice(0, 2).join(' '))).toEqual(['git rev-parse', 'make -p', 'git remote'])
    for (const probe of probes) expect(probe.signal).toBeInstanceOf(AbortSignal)
    const make = probes.find((c) => c.argv[0] === 'make')
    expect(make?.wallMs).toBe(30_000)
    expect(make?.tailChars).toBe(Number.POSITIVE_INFINITY)
  })

  test('a make probe that times out is logged and falls back to the agent path', async () => {
    const warnings: { message: string; meta?: Record<string, unknown> }[] = []
    const host = new FakeAgentHost(async () => ({ output: GREEN }))
    const { exec } = fakeExec((r) => (r.argv[0] === 'make' && r.argv[1] === '-p' ? { timedOut: true } : undefined))
    const { result } = await run({
      exec,
      host,
      input: { cwd: repo() },
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    })
    expect(result.output).toEqual(GREEN)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('probe did not complete')
    expect(warnings[0]?.meta).toMatchObject({ timedOut: true })
  })

  test('a command killed by a signal this host did not send is never a red: the step runs again', async () => {
    let makes = 0
    const { exec } = fakeExec((r) =>
      r.argv[0] === 'make' && r.argv[1] === 'check' && ++makes === 1
        ? { exitCode: null, signalCode: 'SIGKILL', output: 'Killed' }
        : undefined,
    )
    const { runId, result } = await run({ exec, input: { cwd: repo() } })
    expect(result).toMatchObject({ status: 'done', output: { passed: true } })
    expect(makes).toBe(2)
    expect((await sql.step(runId, 'make-check'))?.status).toBe('done')
  })

  test('the command gets a group file keyed by run and step under the state directory', async () => {
    const { exec, calls } = fakeExec(() => undefined)
    const { runId } = await run({ exec, input: { cwd: repo() } })
    const make = calls.find((c) => c.argv[0] === 'make' && c.argv[1] === 'check')
    expect(make?.groupFile).toBe(join(tmpdir(), 'check', `${runId}_make-check.group`))
  })
})

describe('resume', () => {
  test('a crash after make check resumes without running make check again', async () => {
    const cwd = repo()
    // first process: make check finishes, then fallow never answers
    const first = fakeExec(
      async (r) => {
        if (r.argv[0] === 'fallow') {
          await new Promise<void>((_, reject) =>
            r.signal?.addEventListener('abort', () => reject(r.signal?.reason), { once: true }),
          )
        }
        return undefined
      },
      ['make', 'fallow'],
    )
    const wf1 = checkWorkflow(first.exec)
    const rt1 = testRuntime({ schema: db.schema, workflows: [wf1] })
    await rt1.open()
    const { runId } = await rt1.start(wf1, { cwd }, { purpose: 'build' })
    await until(async () => (await sql.step(runId, 'make-check'))?.status === 'done', 'make check journaled')
    await until(() => first.ran('fallow', 'audit', '--quiet') > 0, 'fallow started')
    await rt1.close() // the process goes away mid-run
    expect((await sql.run(runId))?.status).toBe('running')
    expect(first.ran('make', 'check')).toBe(1)

    // second process picks the run up from the journal
    const second = fakeExec(() => undefined, ['make', 'fallow'])
    const wf2 = checkWorkflow(second.exec)
    const rt2 = testRuntime({ schema: db.schema, workflows: [wf2] })
    await rt2.open()
    try {
      const result = await rt2.wait(runId)
      expect(result.status).toBe('done')
      expect(result.output).toEqual({
        passed: true,
        steps: [
          { name: 'check', passed: true },
          { name: 'fallow', passed: true },
        ],
        summary: 'make check passed; fallow audit --quiet passed',
      })
      expect(second.ran('make', 'check')).toBe(0)
      expect(second.ran('make', '-p', '-q')).toBe(0) // the plan is journaled too
    } finally {
      await rt2.close()
    }
  })
})

describe('definition', () => {
  test('the fingerprint agent matches agents/check', () => {
    const [entry] = createCheckWorkflows({ exec: fakeExec(() => undefined).exec })
    const agent = JSON.parse(readFileSync(join(import.meta.dir, '../../../agents/check/agent.json'), 'utf8')) as {
      route: string
      permissions: { shell: boolean }
    }
    expect(entry?.agents).toEqual([{ agent: 'check', route: 'check' }])
    expect(agent.route).toBe('check')
    expect(agent.permissions.shell).toBe(true)
    expect(entry?.workflow.id).toBe('check')
  })
})

describe('over HTTP', () => {
  test('the host serves it as `agw check`: strict input, cwd and commands as flags', async () => {
    const t = await startTestHost({
      prefix: 'checkhttp',
      extra: createCheckWorkflows({ exec: fakeExec(() => undefined).exec }),
    })
    try {
      for (const body of [{ cwd: 'relative' }, { cwd: '/tmp', typo: 1 }]) {
        expect((await t.call('/workflows/check', { body })).status).toBe(400)
      }
      const doc = (await t.host.openapi()) as {
        paths: Record<string, { post: { 'x-cli': { command: string[] }; requestBody: unknown } }>
      }
      const operation = doc.paths['/workflows/check']?.post
      expect(operation?.['x-cli'].command).toEqual(['check'])
      const schema = JSON.stringify(operation?.requestBody)
      expect(schema).toContain('"commands"')
      expect(schema).toContain('"stepTimeoutSeconds"')
    } finally {
      await t.close()
    }
  })
})
