import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCases } from '../src/cases.ts'
import { CheckCase, ReviewCase } from '../src/cases.ts'
import { agwCheckRunner, agwJudge, agwReviewRunner, psqlJournal } from '../src/harness/adapters/agw.ts'
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

  test('extra args are appended to every review and check call, before --format', async () => {
    const review = scripted([{ stdout: JSON.stringify({ runId: 'r5', status: 'done', output: reviewOutput() }) }])
    await agwReviewRunner({
      exec: review.fake,
      journal: noJournal,
      journalAttempts: 1,
      sleep: async () => {},
      args: ['--depth', 'deep'],
    }).review({
      cwd: '/x',
      context: 'c',
    })
    expect(review.calls[0]?.args).toEqual([
      'review',
      '--cwd',
      '/x',
      '--scope',
      'uncommitted',
      '--context',
      'c',
      '--depth',
      'deep',
      '--format',
      'json',
    ])
    const checkOutput = { passed: true, steps: [{ name: 'check', passed: true }], summary: '' }
    const check = scripted([{ stdout: JSON.stringify({ runId: 'r6', status: 'done', output: checkOutput }) }])
    const checked = await agwCheckRunner({
      exec: check.fake,
      journal: noJournal,
      journalAttempts: 1,
      sleep: async () => {},
      args: ['--x', 'y'],
    }).check({ cwd: '/x' })
    expect(checked.output.passed).toBe(true)
    expect(check.calls[0]?.args).toEqual(['check', '--cwd', '/x', '--x', 'y', '--format', 'json'])
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
          model: 'decision-model',
          truncatedChars: 0,
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

  test("the judge refuses output that is not decide's shape", async () => {
    const judge = (stdout: string) =>
      agwJudge({ exec: scripted([{ stdout }]).fake })
        .sameDefect({ a: { file: 'a', message: 'x' }, b: { file: 'a', message: 'y' }, diff: '' })
        .then(
          () => 'resolved',
          (e: unknown) => String(e),
        )
    expect(await judge(JSON.stringify({ answers: { same: { value: true } } }))).toContain('unexpected output')
    const choice = { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: {} }
    expect(await judge(JSON.stringify({ answers: { same: choice }, model: 'm', truncatedChars: 0 }))).toContain(
      'no boolean answer',
    )
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

  test('--agw-args is split on whitespace, reaches every agw call and is recorded in report.json and report.md', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const dry: string[] = []
    await main(['review', '--dry-run', '--agw-args=--depth deep'], {
      env,
      exec,
      out: (l) => dry.push(l),
      err: () => {},
    })
    expect(dry.join('\n')).toContain('agw args --depth deep')

    const agwCalls: string[][] = []
    const fake: Exec = async (cmd, args, options) => {
      if (cmd === 'git') return exec(cmd, args, options)
      if (cmd === 'agw') {
        agwCalls.push(args)
        return { code: 0, stdout: JSON.stringify({ runId: 'r1', status: 'done', output: reviewOutput() }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'no journal in this test' }
    }
    const out: string[] = []
    const code = await main(['review', '--agw-args=  --depth   deep '], {
      env: { ...env, AGW_EVAL_PG_PASSWORD: 'x' },
      exec: fake,
      out: (l) => out.push(l),
      err: () => {},
      now: () => new Date('2026-10-28T00:00:00.000Z'),
    })
    expect(code).toBe(0)
    expect(agwCalls).toHaveLength(1)
    expect(agwCalls[0]?.slice(-4)).toEqual(['--depth', 'deep', '--format', 'json'])
    const dir = join(evalDir, 'reports', readdirSync(join(evalDir, 'reports'))[0] as string)
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).meta.agwArgs).toEqual(['--depth', 'deep'])
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('agw args `--depth deep`')
    expect(out.join('\n')).toContain('agw args `--depth deep`')
  })

  test('--agw-args on check is a usage error: nothing runs', async () => {
    const { fx, evalDir, env } = evalEnv()
    mkdirSync(join(evalDir, 'check'), { recursive: true })
    writeCases(join(evalDir, 'check', 'cases.jsonl'), CheckCase, [checkCase({ baseSha: fx.baseSha })])
    const err: string[] = []
    const calls: string[] = []
    const spy: Exec = async (cmd) => {
      calls.push(cmd)
      return { code: 0, stdout: '', stderr: '' }
    }
    for (const argv of [
      ['check', '--agw-args=--x y'],
      ['check', '--dry-run', '--agw-args=--x y'],
    ]) {
      expect(await main(argv, { env, exec: spy, out: () => {}, err: (l) => err.push(l) })).toBe(2)
    }
    expect(err.join('\n')).toContain('--agw-args applies to review only')
    expect(calls).toEqual([])
  })

  test('--resume pins --agw-args in run.json: a different value is a usage error naming both, the same one resumes', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    let agwRuns = 0
    const fake: Exec = async (cmd, args, options) => {
      if (cmd === 'git') return exec(cmd, args, options)
      if (cmd === 'agw') {
        agwRuns++
        return { code: 0, stdout: JSON.stringify({ runId: 'r1', status: 'done', output: reviewOutput() }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'no journal in this test' }
    }
    const deps = (err: string[] = []) => ({
      env: { ...env, AGW_EVAL_PG_PASSWORD: 'x' },
      exec: fake,
      out: () => {},
      err: (l: string) => err.push(l),
    })
    expect(await main(['review', '--agw-args=--depth deep'], deps())).toBe(0)
    const dir = join(evalDir, 'reports', readdirSync(join(evalDir, 'reports'))[0] as string)
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))).toEqual({ agwArgs: ['--depth', 'deep'] })

    const err: string[] = []
    expect(await main(['review', '--resume', dir, '--agw-args=--depth light'], deps(err))).toBe(2)
    expect(err.join('\n')).toContain('--depth deep')
    expect(err.join('\n')).toContain('--depth light')
    expect(await main(['review', '--resume', dir], deps(err))).toBe(2) // none given, one stored
    expect(agwRuns).toBe(1)

    expect(await main(['review', '--resume', dir, '--agw-args=--depth deep'], deps())).toBe(0)
    expect(agwRuns).toBe(1) // the finished case was skipped
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

  test('--ids naming an unknown case exits 2 and names it; nothing runs', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const err: string[] = []
    const calls: string[] = []
    const spy: Exec = async (cmd) => {
      calls.push(cmd)
      return { code: 0, stdout: '', stderr: '' }
    }
    const code = await main(['review', '--ids', 'a,typo,gone'], {
      env,
      exec: spy,
      out: () => {},
      err: (l) => err.push(l),
    })
    expect(code).toBe(2)
    expect(err.join()).toContain('unknown case ids')
    expect(err.join()).toContain('typo, gone')
    expect(calls).toEqual([])
    expect(readdirSync(evalDir)).toEqual(['review'])
  })

  test('usage errors exit 2', async () => {
    const err: string[] = []
    expect(await main(['nope'], { env: {}, exec, out: () => {}, err: (l) => err.push(l) })).toBe(2)
    expect(err.join()).toContain('usage:')
  })
})
