// What an agent sees on its first call: group help that exits 0, a wait that names its own resume budget, time flags
// that take a duration, a cut text that says so, and error lines whose first 400 bytes already hold the answer.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgwError, EXIT } from '../src/exit.ts'
import { adviceFor, FOREGROUND_CAP_S } from '../src/pending.ts'
import { parseWhen } from '../src/when.ts'
import { FIXTURE_WORKFLOWS, type FakeHost, startFakeHost } from './fake-host.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'agw.ts')
setDefaultTimeout(20_000)

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Out {
  code: number
  stdout: string
  stderr: string
}

let host: FakeHost
async function agw(args: string[], env: Record<string, string> = {}): Promise<Out> {
  const dir = mkdtempSync(join(tmpdir(), 'agw-ux-'))
  dirs.push(dir)
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      AGW_RESTART_WAIT_S: '0',
      AGW_URL: host.url,
      AGW_API_SECRET: host.secret,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const typicalRunId = '0198e2c4-7a1b-7d3e-9f40-5b6c1a2d3e4f'
let typicalWallS: number | undefined
const accepted = () =>
  Response.json(
    {
      runId: typicalRunId,
      workflowId: 'fixture.accepted',
      status: 'running',
      ...(typicalWallS === undefined ? {} : { typicalWallS }),
    },
    { status: 202 },
  )

beforeAll(async () => {
  host = await startFakeHost({
    workflows: [
      ...FIXTURE_WORKFLOWS,
      {
        id: 'fixture.srv',
        summary: 'Only a server calls this',
        input: { type: 'object', properties: {} },
        serverOnly: true,
      },
      {
        id: 'hidden.job',
        summary: 'A group of server-only commands',
        input: { type: 'object', properties: {} },
        serverOnly: true,
      },
      {
        id: 'fixture.accepted',
        summary: 'Answers 202 at once; the run itself is never stored',
        input: { type: 'object', properties: {} },
        outcome: () => ({ respond: accepted() }),
      },
    ],
  })
  host.interceptRuns(() => accepted())
})
afterAll(async () => {
  await host.stop()
})

describe('a group asked for help', () => {
  for (const group of ['llm', 'run', 'fixture']) {
    for (const flags of [[], ['--help']]) {
      test(`agw ${[group, ...flags].join(' ')} lists one line per command and exits 0`, async () => {
        const r = await agw([group, ...flags])
        expect(r.code).toBe(EXIT.ok)
        expect(r.stderr).toBe('')
        const rows = r.stdout.split('\n').filter((l) => l.startsWith('  '))
        expect(rows.length).toBeGreaterThan(1)
        for (const row of rows) expect(row.trim().startsWith(group)).toBe(true)
        if (group === 'run') expect(r.stdout).toContain('Wait for a run')
      })
    }
  }

  test('server-only commands stay out of the listing, and a group of nothing else is no group', async () => {
    const r = await agw(['fixture'])
    expect(r.stdout).toContain('fixture echo')
    expect(r.stdout).not.toContain('fixture srv')
    expect((await agw(['hidden'])).code).toBe(EXIT.usage)
  })

  test('a word that is no group stays a usage error', async () => {
    const r = await agw(['fixture', 'nope'])
    expect(r.code).toBe(EXIT.usage)
  })
})

describe('the wait budget', () => {
  test('agw run wait <id> --budget 2 returns pending after about 2 s with one resume command', async () => {
    typicalWallS = undefined
    const started = Date.now()
    const r = await agw(['run', 'wait', typicalRunId, '--budget', '2'])
    const took = Date.now() - started
    expect(r.code).toBe(EXIT.pending)
    expect(took).toBeLessThan(8000)
    const error = (
      JSON.parse(r.stderr) as { error: { hint: string; message: string; details: Record<string, unknown> } }
    ).error
    expect(error.hint).toBe(`agw run wait ${typicalRunId} --budget 300`)
    expect(error.message).toContain('Do not loop')
    expect(error.details.budgetS).toBe(2)
  })

  test('--wait on a workflow verb sets its own wait', async () => {
    typicalWallS = undefined
    const r = await agw(['fixture', 'accepted', '--wait', '1'])
    expect(r.code).toBe(EXIT.pending)
    expect((JSON.parse(r.stderr) as { error: { details: Record<string, unknown> } }).error.details.budgetS).toBe(1)
  })

  test('the printed budget follows the typical wall time and stops at the foreground cap', async () => {
    typicalWallS = 100
    const short = await agw(['run', 'wait', typicalRunId, '--budget', '1'])
    const shortError = (JSON.parse(short.stderr) as { error: { hint: string; details: Record<string, unknown> } }).error
    expect(shortError.hint).toBe(`agw run wait ${typicalRunId} --budget 125`)
    expect(shortError.details.typicalWallS).toBe(100)

    typicalWallS = 1200
    const long = await agw(['run', 'wait', typicalRunId, '--budget', '1'])
    const longError = (
      JSON.parse(long.stderr) as { error: { hint: string; message: string; details: Record<string, unknown> } }
    ).error
    expect(longError.hint).toBe(`agw run wait ${typicalRunId} --budget ${FOREGROUND_CAP_S}`)
    expect(longError.details).toMatchObject({ needsS: 1500, runInBackground: true })
    expect(longError.message).toContain('background it with --budget 1500')
    expect(longError.message.endsWith('…')).toBe(false)
    typicalWallS = undefined
  })

  test('the first 400 bytes of a pending answer hold the run id and the resume command', async () => {
    typicalWallS = 1200
    const r = await agw(['run', 'wait', typicalRunId, '--budget', '1'])
    typicalWallS = undefined
    expect(r.code).toBe(EXIT.pending)
    expect(Buffer.byteLength(r.stderr)).toBeLessThan(700)
    const head = Buffer.from(r.stderr).subarray(0, 400).toString()
    expect(head).toContain(typicalRunId)
    expect(head).toContain(`agw run wait ${typicalRunId} --budget ${FOREGROUND_CAP_S}`)
    // As an agent sees it after `2>&1`: the state first, the error line behind it.
    const together = Buffer.from(r.stdout + r.stderr)
      .subarray(0, 400)
      .toString()
    expect(together).toContain(typicalRunId)
    expect(together).toContain('agw run wait')
  })

  test('an interrupted wait of a run that needs a background wait still fits the budget in the message head', async () => {
    const advice = adviceFor({ typicalWallS: 1200, waitedS: 110, interrupted: 'SIGINT' })
    const error = new AgwError('pending', `run ${typicalRunId} ${advice.message}`)
    expect(error.message.length).toBeLessThanOrEqual(170)
    expect(JSON.parse(error.toErrorLine()).error.message).toContain('--budget 1500')
  })

  test('adviceFor: no history waits 300 s, a short run at least 60 s', () => {
    expect(adviceFor({ waitedS: 110 }).budgetS).toBe(300)
    expect(adviceFor({ typicalWallS: 5, waitedS: 110 }).budgetS).toBe(60)
    expect(adviceFor({ typicalWallS: 5, waitedS: 110, interrupted: 'SIGINT' }).message).toContain('SIGINT')
  })
})

describe('a usage error', () => {
  test('keeps kind, message and the start of the hint inside the first 400 bytes', async () => {
    const r = await agw(['fixture', 'echo', 'hi', '--bogus-flag'])
    expect(r.code).toBe(EXIT.usage)
    const head = Buffer.from(r.stderr).subarray(0, 400).toString()
    expect(head).toContain('"kind":"usage"')
    expect(head).toContain('unknown flag --bogus-flag')
    expect(head).toContain('valid flags: --duration-s')
  })

  test('a long message and hint are cut in the head and kept whole behind it', () => {
    const unicode = new AgwError('usage', 'ä'.repeat(200), { hint: '"'.repeat(200) })
    const head = unicode.toErrorLine().slice(0, unicode.toErrorLine().indexOf('"details"'))
    expect(Buffer.byteLength(head)).toBeLessThan(400)
    const long = new AgwError('usage', `bad value ${'x'.repeat(400)}`, {
      hint: `try ${'y'.repeat(400)}`,
      details: { a: 1 },
    })
    const line = JSON.parse(long.toErrorLine()) as {
      error: { message: string; hint: string; details: Record<string, unknown> }
    }
    expect(Buffer.byteLength(long.toErrorLine().slice(0, long.toErrorLine().indexOf('"details"')))).toBeLessThan(400)
    expect(line.error.message.endsWith('…')).toBe(true)
    expect(line.error.details.message).toBe(long.message)
    expect(line.error.details.hint).toBe(long.hint)
    expect(line.error.details.a).toBe(1)
  })
})

describe('time flags', () => {
  test('parseWhen: a duration is that long before now, ISO and other text pass through', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z')
    expect(parseWhen('30m', now)).toBe('2026-11-16T11:30:00.000Z')
    expect(parseWhen('24h', now)).toBe('2026-11-15T12:00:00.000Z')
    expect(parseWhen('7d', now)).toBe('2026-11-09T12:00:00.000Z')
    expect(parseWhen('2w', now)).toBe('2026-11-02T12:00:00.000Z')
    expect(parseWhen('2026-11-01T00:00:00Z', now)).toBe('2026-11-01T00:00:00Z')
    expect(parseWhen('yesterday', now)).toBe('yesterday')
  })

  test('--since 7d and --iu-since 24h reach the host as ISO instants; other string flags are left alone', async () => {
    const before = Date.now()
    const r = await agw(['fixture', 'window', '--since', '7d', '--iu-since', '24h', '--label', '7d'])
    expect(r.code).toBe(EXIT.ok)
    const out = (JSON.parse(r.stdout) as { output: { since: string; iuSince: string; label: string } }).output
    expect(Math.abs(Date.parse(out.since) - (before - 7 * 86_400_000))).toBeLessThan(60_000)
    expect(Math.abs(Date.parse(out.iuSince) - (before - 86_400_000))).toBeLessThan(60_000)
    expect(out.label).toBe('7d')
    const iso = await agw(['fixture', 'window', '--since', '2026-11-01T00:00:00Z'])
    expect((JSON.parse(iso.stdout) as { output: { since: string } }).output.since).toBe('2026-11-01T00:00:00Z')
  })

  test('a --since the host reads as a duration (x-cli.typedFlags) reaches it as typed', async () => {
    const r = await agw(['fixture', 'duration', '--since', '3d'])
    expect(r.code).toBe(EXIT.ok)
    expect((JSON.parse(r.stdout) as { output: { since: string } }).output.since).toBe('3d')
  })
})

describe('a cut text', () => {
  test('plain output says on stderr that it was cut and how to read more; stdout stays the text', async () => {
    const r = await agw(['fixture', 'text', '--format', 'plain'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout.trim()).toHaveLength(100)
    expect(r.stderr).toContain('output cut at 100 characters')
    expect(r.stderr).toContain('--max-chars <n> reads more (max 500)')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
  })

  test('JSON output has no note (the field says it)', async () => {
    const r = await agw(['fixture', 'text'])
    expect(r.stderr).toBe('')
    expect((JSON.parse(r.stdout) as { output: { truncated: boolean } }).output.truncated).toBe(true)
  })

  test('help names the cap and the cut report', async () => {
    const r = await agw(['fixture', 'text', '--help'])
    expect(r.stdout).toContain('default 100, max 500')
    expect(r.stdout).toContain('text is cut at --max-chars (default 100, max 500)')
  })
})
