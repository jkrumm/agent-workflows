import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCases } from '../src/cases.ts'
import { CheckCase, ReviewCase } from '../src/cases.ts'
import { agwJudge, agwReviewRunner, psqlJournal } from '../src/harness/adapters/agw.ts'
import { legacyReviewRunner, usageTrackerCost } from '../src/harness/adapters/legacy.ts'
import { main } from '../src/harness/cli.ts'
import { type Exec, type ExecOptions, exec } from '../src/harness/exec.ts'
import { BAD_DIFF, checkCase, fixtureHome, reviewCase, reviewOutput } from './harness-support.ts'

type Call = { cmd: string; args: string[]; options?: ExecOptions }

/** Answers each call with the next scripted reply and records it. */
function scripted(replies: { code?: number; stdout?: string; stderr?: string }[]) {
  const calls: Call[] = []
  const fake: Exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    const reply = replies.shift() ?? {}
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { fake, calls }
}

const noJournal = { runCost: async () => null }

describe('agw adapter', () => {
  test('a pending run is resumed with run wait; spend comes from the journal; purpose eval', async () => {
    const output = reviewOutput()
    const { fake, calls } = scripted([
      { code: 10, stdout: JSON.stringify({ runId: 'r1', status: 'running' }) },
      { code: 0, stdout: JSON.stringify({ runId: 'r1', status: 'done', output }) },
    ])
    const journal = {
      runCost: async () => ({
        costUsd: 0.02,
        wallMs: 5000,
        tokensInput: 1,
        tokensOutput: 1,
        tokensCacheRead: 0,
        unpricedCalls: 0,
      }),
    }
    const run = await agwReviewRunner({ exec: fake, journal }).review({ cwd: '/tmp/x', depth: 'deep' })
    expect(run).toMatchObject({ runId: 'r1', spend: { costUsd: 0.02, costExact: true, wallMs: 5000 } })
    expect(calls[0]?.args).toEqual([
      'review',
      '--cwd',
      '/tmp/x',
      '--scope',
      'uncommitted',
      '--depth',
      'deep',
      '--format',
      'json',
    ])
    expect(calls[1]?.args).toEqual(['run', 'wait', 'r1', '--format', 'json'])
    expect(calls.every((c) => c.options?.env?.AGW_PURPOSE === 'eval')).toBe(true)
  })

  test('a failed run throws with its id; a missing journal row leaves the cost unknown', async () => {
    const failed = scripted([
      { code: 1, stdout: JSON.stringify({ runId: 'r2', status: 'failed', error: { message: 'boom' } }) },
    ])
    const runner = agwReviewRunner({ exec: failed.fake, journal: noJournal, journalAttempts: 1, sleep: async () => {} })
    const error = await runner.review({ cwd: '/x' }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(String(error)).toContain('run r2 failed: boom')

    const done = scripted([{ stdout: JSON.stringify({ runId: 'r3', status: 'done', output: reviewOutput() }) }])
    const run = await agwReviewRunner({
      exec: done.fake,
      journal: noJournal,
      journalAttempts: 1,
      sleep: async () => {},
    }).review({
      cwd: '/x',
    })
    expect(run.spend.costUsd).toBeNull()
    expect(run.spend.costExact).toBe(false)
  })

  test('a journal failure after a paid run keeps the output and leaves the cost unknown', async () => {
    const done = scripted([{ stdout: JSON.stringify({ runId: 'r4', status: 'done', output: reviewOutput() }) }])
    const journal = {
      runCost: async () => {
        throw new Error('psql: connection refused')
      },
    }
    const run = await agwReviewRunner({ exec: done.fake, journal }).review({ cwd: '/x' })
    expect(run.output.outcome).toBe('actionable')
    expect(run.spend).toMatchObject({ costUsd: null, costExact: false })
  })

  test('a failed password read is not cached', async () => {
    const { fake, calls } = scripted([
      { code: 1, stderr: 'not in cache' },
      { code: 0, stdout: 'pw\n' },
      { stdout: 'done|0.01|10|1|1|0|0\n' },
    ])
    const journal = psqlJournal({ exec: fake, env: {} })
    const first = await journal.runCost('r').then(
      () => 'resolved',
      (e: unknown) => String(e),
    )
    expect(first).toContain('secrets-run read')
    expect(await journal.runCost('r')).toMatchObject({ costUsd: 0.01 })
    expect(calls.map((c) => c.cmd)).toEqual(['secrets-run', 'secrets-run', 'psql'])
  })

  test('the judge sends a blinded state on stdin and reads the boolean answer', async () => {
    const { fake, calls } = scripted([
      {
        stdout: JSON.stringify({
          answers: { same: { type: 'boolean', value: true, confidence: 0.9, probability: 0.9 } },
        }),
      },
    ])
    const same = await agwJudge({ exec: fake }).sameDefect({
      a: { file: 'a.ts', line: 1, message: 'zeta' },
      b: { file: 'a.ts', line: 2, message: 'alpha' },
      diff: 'the diff',
    })
    expect(same).toBe(true)
    const state = calls[0]?.options?.stdin ?? ''
    expect(state.indexOf('alpha')).toBeLessThan(state.indexOf('zeta'))
    expect(state).not.toMatch(/legacy|new side/i)
    expect(calls[0]?.args[0]).toBe('decide')
  })

  test('the journal is read-only, binds the run id and refuses an odd schema name', async () => {
    const { fake, calls } = scripted([{ stdout: 'done|0.0123|4567|100|20|50|1\n' }])
    const journal = psqlJournal({ exec: fake, env: { AGW_EVAL_PG_PASSWORD: 'pw', AGW_PG_SCHEMA: 'agw' } })
    expect(await journal.runCost("r'1")).toEqual({
      costUsd: 0.0123,
      wallMs: 4567,
      tokensInput: 100,
      tokensOutput: 20,
      tokensCacheRead: 50,
      unpricedCalls: 1,
    })
    expect(calls[0]?.options?.env?.PGOPTIONS).toContain('default_transaction_read_only=on')
    expect(calls[0]?.args).toContain("id=r'1")
    expect(calls[0]?.options?.stdin).toContain(`where id = :'id'`)
    expect(() => psqlJournal({ exec: fake, env: { AGW_PG_SCHEMA: 'x; drop' } })).toThrow()
    const running = scripted([{ stdout: 'running|||0|0|0|0\n' }])
    expect(await psqlJournal({ exec: running.fake, env: { AGW_EVAL_PG_PASSWORD: 'pw' } }).runCost('r')).toBeNull()
  })
})

describe('legacy adapter', () => {
  test('usage-tracker cost: session rows by job id are exact, IU rows by window make it approximate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-eval-usage-'))
    const sessions = [
      { jobId: 'j1', tool: 'review:angle', costUsd: 0.1 },
      { jobId: 'j1', tool: 'review:synthesis', costUsd: 0.01 },
      { jobId: 'j2', tool: 'review:angle', costUsd: 5 },
    ]
    const iu = [
      { ts: '2026-10-28T01:00:30.000Z', tool: 'review:adversary', cost_usd: 0.02 },
      { ts: '2026-10-28T02:00:00.000Z', tool: 'review:adversary', cost_usd: 9 },
      { ts: '2026-10-28T01:00:40.000Z', tool: 'prose:lint', cost_usd: 9 },
    ]
    writeFileSync(join(dir, 'agent-gateway-sessions.jsonl'), `${sessions.map((r) => JSON.stringify(r)).join('\n')}\n`)
    writeFileSync(join(dir, 'agent-gateway-iu.jsonl'), `${iu.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`)
    const cost = usageTrackerCost(dir)
    const window = { startMs: Date.parse('2026-10-28T01:00:00Z'), endMs: Date.parse('2026-10-28T01:01:00Z') }
    const j1 = await cost.jobCost({ jobId: 'j1', tool: 'review', ...window })
    expect(j1.costUsd).toBeCloseTo(0.13)
    expect(j1.exact).toBe(false)
    const j2 = await cost.jobCost({ jobId: 'j2', tool: 'review', startMs: 0, endMs: 1 })
    expect(j2).toEqual({ costUsd: 5, exact: true })
    expect(await cost.jobCost({ jobId: 'none', tool: 'check', startMs: 0, endMs: 1 })).toEqual({
      costUsd: null,
      exact: false,
    })
  })

  test('review submits with --no-wait, waits, and reads the job window', async () => {
    const { fake, calls } = scripted([
      { stdout: JSON.stringify({ jobId: 'j9' }) },
      { stdout: JSON.stringify(reviewOutput()) },
      { stdout: JSON.stringify({ id: 'j9', status: 'done', startedAt: 1000, finishedAt: 61_000, elapsedMs: 60_000 }) },
    ])
    let asked: unknown
    const cost = {
      jobCost: async (job: unknown) => {
        asked = job
        return { costUsd: 0.03, exact: true }
      },
    }
    const run = await legacyReviewRunner({ exec: fake, cost }).review({ cwd: '/tmp/clone', depth: 'deep' })
    expect(run).toMatchObject({ runId: 'j9', spend: { costUsd: 0.03, wallMs: 60_000 } })
    expect(calls[0]?.args).toEqual([
      'review',
      '--repo',
      '/tmp/clone',
      '--scope',
      'uncommitted',
      '--no-wait',
      '--json',
      '--caller',
      'eval',
    ])
    expect(calls[1]?.args).toEqual(['wait', 'j9', '--json', '--quiet'])
    expect(asked).toEqual({ jobId: 'j9', tool: 'review', startMs: 1000, endMs: 61_000 })
  })
})

describe('cli', () => {
  function evalEnv() {
    const fx = fixtureHome()
    const evalDir = mkdtempSync(join(tmpdir(), 'agw-eval-dir-'))
    const env = { AGW_EVAL_DIR: evalDir, AGW_EVAL_HOME: fx.home }
    return { fx, evalDir, env }
  }

  test('--dry-run materializes, prints the plan and the IU estimate, and calls no side', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'b', baseSha: fx.baseSha, diff: BAD_DIFF }),
      reviewCase({ id: 'c', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const out: string[] = []
    const seen: string[] = []
    const spy: Exec = (cmd, args, options) => {
      seen.push(cmd)
      return exec(cmd, args, options)
    }
    const code = await main(['review', '--dry-run', '--limit', '2'], {
      env,
      exec: spy,
      out: (l) => out.push(l),
      err: () => {},
    })
    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('plan: review, 2 cases')
    expect(text).toContain('skipped: apply_failed')
    expect(text).toContain('ready 1/2')
    expect(text).toContain('IU estimate: $0.0400')
    expect(seen.every((cmd) => cmd === 'git')).toBe(true)
    expect(readdirSync(evalDir)).toEqual(['review'])
  })

  test('a check dry run names the setup step', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeFileSync(join(fx.repo, 'bun.lock'), '{}')
    Bun.spawnSync(['git', 'add', 'bun.lock'], { cwd: fx.repo })
    Bun.spawnSync(['git', '-c', 'user.email=e@example.com', '-c', 'user.name=e', 'commit', '-qm', 'lock'], {
      cwd: fx.repo,
    })
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: fx.repo }).stdout.toString().trim()
    mkdirSync(join(evalDir, 'check'), { recursive: true })
    writeCases(join(evalDir, 'check', 'cases.jsonl'), CheckCase, [checkCase({ baseSha: sha })])
    const out: string[] = []
    expect(await main(['check', '--dry-run'], { env, exec, out: (l) => out.push(l), err: () => {} })).toBe(0)
    expect(out.join('\n')).toContain('ready (setup: bun install --frozen-lockfile)')
  })

  test('usage errors exit 2', async () => {
    const err: string[] = []
    expect(await main(['nope'], { env: {}, exec, out: () => {}, err: (l) => err.push(l) })).toBe(2)
    expect(err.join()).toContain('usage:')
  })
})
