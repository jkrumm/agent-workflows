import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, ReviewCase, writeCases } from '../src/cases.ts'
import { aggregateCheck, aggregateReview } from '../src/harness/aggregate.ts'
import { main, resolveRunDir } from '../src/harness/cli.ts'
import { type Exec, exec } from '../src/harness/exec.ts'
import type { ReviewOutput, ReviewRequest, ReviewRunner } from '../src/harness/ports.ts'
import { renderAggregate, renderMarkdown } from '../src/harness/report.ts'
import {
  DEFAULT_THRESHOLD,
  readRows,
  reproducibleCases,
  type SelfAgreementOptions,
  selfAgreementCheck,
  selfAgreementReview,
} from '../src/harness/reproducibility.ts'
import { runCheck, runReview } from '../src/harness/run.ts'
import { checkVerdict, reviewVerdict } from '../src/harness/verdict.ts'
import { BAD_DIFF, checkCase, fixtureHome, reviewCase, reviewOutput } from './harness-support.ts'

const spend = { costUsd: 0.04, costExact: true, wallMs: 1 }
const clean = reviewOutput({ outcome: 'clean', blocking: [] })

function options(home: string, overrides: Partial<SelfAgreementOptions> = {}): SelfAgreementOptions {
  return {
    exec,
    home,
    concurrency: 1,
    keep: false,
    depthMode: 'matched',
    resultsPath: join(mkdtempSync(join(tmpdir(), 'agw-eval-repro-')), 'reproducibility.jsonl'),
    side: 'legacy',
    runs: 2,
    threshold: DEFAULT_THRESHOLD,
    ...overrides,
  }
}

/** Answers the n-th call with the n-th output and records the requests. */
function scripted(outputs: (ReviewOutput | Error)[]) {
  const calls: ReviewRequest[] = []
  const runner: ReviewRunner = {
    async review(request) {
      calls.push(request)
      const next = outputs[calls.length - 1] ?? reviewOutput()
      if (next instanceof Error) throw next
      return { output: next, spend }
    },
  }
  return { runner, calls }
}

describe('self-agreement: review', () => {
  test('a case whose reruns agree with the recorded run is reproducible; one that loses its blocker is not', async () => {
    const fx = fixtureHome()
    const cases = ['stable', 'flaky'].map((id) => reviewCase({ id, baseSha: fx.baseSha, diff: fx.diff }))
    const { runner } = scripted([reviewOutput(), reviewOutput(), clean, clean])
    const opts = options(fx.home)
    const outcomes = await selfAgreementReview(cases, { runner }, opts)
    expect(outcomes.map((o) => o.status)).toEqual(['measured', 'measured'])
    const rows = readRows(opts.resultsPath)
    expect(rows.find((r) => r.id === 'stable')).toMatchObject({
      side: 'legacy',
      runs: 2,
      outcomeAgreement: 1,
      blockingRecall: 1,
      reproducible: true,
    })
    // recorded actionable vs two clean reruns: 1 of 3 pairs agree; the recorded blocker is found in neither rerun
    expect(rows.find((r) => r.id === 'flaky')).toMatchObject({
      outcomeAgreement: 1 / 3,
      blockingRecall: 0,
      reproducible: false,
    })
    expect(reproducibleCases(rows)).toEqual(
      new Map([
        ['stable', true],
        ['flaky', false],
      ]),
    )
  })

  test('the threshold is configurable', async () => {
    const fx = fixtureHome()
    const cases = [reviewCase({ id: 'flaky', baseSha: fx.baseSha, diff: fx.diff })]
    const { runner } = scripted([clean, clean])
    const opts = options(fx.home, { threshold: 0 })
    await selfAgreementReview(cases, { runner }, opts)
    expect(readRows(opts.resultsPath)[0]).toMatchObject({ threshold: 0, reproducible: true })
  })

  test('a case without any blocking finding is judged on its outcome alone', async () => {
    const fx = fixtureHome()
    const base = reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff })
    const none = reviewCase({
      id: 'none',
      baseSha: fx.baseSha,
      diff: fx.diff,
      legacy: { ...base.legacy, outcome: 'clean', findings: [] },
    })
    const { runner } = scripted([clean, clean])
    const opts = options(fx.home)
    await selfAgreementReview([none], { runner }, opts)
    expect(readRows(opts.resultsPath)[0]).toMatchObject({
      outcomeAgreement: 1,
      blockingRecall: null,
      reproducible: true,
    })
  })

  test('a failed rerun or an unapplicable diff leaves no row; a measured case is not rerun on the next call', async () => {
    const fx = fixtureHome()
    const cases = [
      reviewCase({ id: 'ok', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'down', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'bad', baseSha: fx.baseSha, diff: BAD_DIFF }),
    ]
    const first = scripted([reviewOutput(), reviewOutput(), reviewOutput(), new Error('host down')])
    const opts = options(fx.home)
    const outcomes = await selfAgreementReview(cases, { runner: first.runner }, opts)
    expect(outcomes.map((o) => [o.id, o.status])).toEqual([
      ['ok', 'measured'],
      ['down', 'error'],
      ['bad', 'skipped'],
    ])
    expect(readRows(opts.resultsPath).map((r) => r.id)).toEqual(['ok'])

    const second = scripted([reviewOutput(), reviewOutput()])
    await selfAgreementReview(cases, { runner: second.runner }, opts)
    expect(second.calls).toHaveLength(2) // only `down` reran
    expect(readRows(opts.resultsPath).map((r) => r.id)).toEqual(['ok', 'down'])
  })

  test('the legacy side gets no depth; the new side gets the depth the legacy run recorded', async () => {
    const fx = fixtureHome()
    const cases = [reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff })]
    const legacy = scripted([])
    await selfAgreementReview(cases, { runner: legacy.runner }, options(fx.home))
    expect(legacy.calls).toHaveLength(2)
    expect(legacy.calls.every((c) => c.depth === undefined)).toBe(true)
    const next = scripted([])
    await selfAgreementReview(cases, { runner: next.runner }, options(fx.home, { side: 'new', runs: 3 }))
    expect(next.calls.map((c) => c.depth)).toEqual(['standard', 'standard', 'standard'])
  })

  test('legacy and new rows of one case are kept apart; the baseline reads the legacy rows only', async () => {
    const fx = fixtureHome()
    const cases = [reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff })]
    const opts = options(fx.home)
    await selfAgreementReview(cases, { runner: scripted([clean, clean]).runner }, opts)
    await selfAgreementReview(cases, { runner: scripted([]).runner }, { ...opts, side: 'new' })
    const rows = readRows(opts.resultsPath)
    expect(rows.map((r) => [r.side, r.reproducible])).toEqual([
      ['legacy', false],
      ['new', true],
    ])
    expect(reproducibleCases(rows)).toEqual(new Map([['a', false]]))
    expect(reproducibleCases(rows.filter((r) => r.side === 'new'))).toBeNull()
  })
})

describe('self-agreement: check', () => {
  test('a recorded red run that reruns green is not reproducible; a stable green run is', async () => {
    const fx = fixtureHome()
    const red = checkCase({
      id: 'red',
      baseSha: fx.baseSha,
      legacy: { passed: false, steps: [{ name: 'check', passed: false }], costUsd: 0, costExact: true, wallMs: 1 },
    })
    const green = checkCase({ id: 'green', baseSha: fx.baseSha })
    const runner = {
      async check() {
        return { output: { passed: true, steps: [{ name: 'check', passed: true }], summary: '' }, spend }
      },
    }
    const opts = options(fx.home)
    await selfAgreementCheck([red, green], runner, opts)
    const rows = readRows(opts.resultsPath)
    expect(rows.find((r) => r.id === 'red')).toMatchObject({
      outcomeAgreement: 1 / 3,
      blockingRecall: 0,
      reproducible: false,
    })
    expect(rows.find((r) => r.id === 'green')).toMatchObject({
      outcomeAgreement: 1,
      blockingRecall: null,
      reproducible: true,
    })
  })
})

describe('recall over reproducible cases', () => {
  async function reviewResults() {
    const fx = fixtureHome()
    const cases = ['a', 'b'].map((id) => reviewCase({ id, baseSha: fx.baseSha, diff: fx.diff }))
    const found = scripted([reviewOutput(), clean])
    const results = await runReview(cases, { next: found.runner }, { ...options(fx.home), concurrency: 1 })
    return results
  }

  test('only reproducible cases count, and the report says how many', async () => {
    const results = await reviewResults()
    const all = aggregateReview(results)
    expect(all.blocking.recall).toBe(0.5)
    expect(all.blocking.basis).toBeNull()

    const only = aggregateReview(
      results,
      1,
      new Map([
        ['a', true],
        ['b', false],
      ]),
    )
    expect(only.blocking.recall).toBe(1)
    expect(only.blocking.basis).toEqual({
      withRecorded: 2,
      counted: 1,
      notReproducible: 1,
      noData: 0,
      matched: 1,
      reference: 1,
    })
    expect(reviewVerdict(only).criteria[0]).toMatchObject({ metric: 'blocking recall', value: 1 })

    const report = { workflow: 'review' as const, meta: meta(), aggregate: only, verdict: reviewVerdict(only), results }
    expect(renderAggregate(report)).toContain(
      'blocking recall counted on 1 of 2 cases with a recorded blocking finding (1/1); 1 not reproducible, 0 without data',
    )
    const noData = { ...report, aggregate: all, verdict: reviewVerdict(all) }
    expect(renderMarkdown(noData)).toContain('no reproducibility data')
  })

  test('a case without a row is neither counted nor called not reproducible', async () => {
    const results = await reviewResults()
    const partial = aggregateReview(results, 1, new Map([['a', true]]))
    expect(partial.blocking.basis).toMatchObject({ counted: 1, notReproducible: 0, noData: 1 })
  })

  test('no reproducible case leaves the recall undecided instead of passing it', async () => {
    const results = await reviewResults()
    const none = aggregateReview(
      results,
      1,
      new Map([
        ['a', false],
        ['b', false],
      ]),
    )
    expect(none.blocking.recall).toBeNull()
    expect(reviewVerdict(none).criteria[0]?.pass).toBeNull()
  })

  test('check: the failure recall counts reproducible red cases only', async () => {
    const fx = fixtureHome()
    const red = (id: string) =>
      checkCase({
        id,
        baseSha: fx.baseSha,
        legacy: { passed: false, steps: [{ name: 'check', passed: false }], costUsd: 0, costExact: true, wallMs: 1 },
      })
    const caught = {
      async check() {
        return { output: { passed: false, steps: [{ name: 'check', passed: false }], summary: '' }, spend }
      },
    }
    const results = await runCheck([red('x')], { next: caught }, { ...options(fx.home) })
    const filtered = aggregateCheck(results, 1, new Map([['x', false]]))
    expect(filtered.failureRecall.recall).toBeNull()
    expect(filtered.failureRecall.basis).toMatchObject({ withRecorded: 1, counted: 0, notReproducible: 1 })
    expect(aggregateCheck(results).failureRecall.recall).toBe(1)
    expect(checkVerdict(filtered).criteria[1]?.pass).toBeNull()
  })
})

const meta = () => ({
  startedAt: '2026-10-28T09:00:00.000Z',
  finishedAt: '2026-10-28T09:10:00.000Z',
  depthMode: 'matched' as const,
  rerunLegacy: false,
  judge: false,
  concurrency: 1,
  seed: 1,
})

describe('--resume', () => {
  test('an absolute path or a run timestamp under reports resolves; anything else is an error', () => {
    const reports = mkdtempSync(join(tmpdir(), 'agw-eval-reports-'))
    mkdirSync(join(reports, '2026-10-28T09-00-00-000Z'))
    expect(resolveRunDir('2026-10-28T09-00-00-000Z', reports)).toBe(join(reports, '2026-10-28T09-00-00-000Z'))
    expect(resolveRunDir(join(reports, '2026-10-28T09-00-00-000Z'), reports)).toBe(
      join(reports, '2026-10-28T09-00-00-000Z'),
    )
    for (const bad of ['reports/2026-10-28T09-00-00-000Z', './run', 'run', '2026-10-28', '../x']) {
      expect(() => resolveRunDir(bad, reports)).toThrow('absolute path or a run timestamp')
    }
    expect(() => resolveRunDir('2026-10-29T09-00-00-000Z', reports)).toThrow('no run directory')
    expect(() => resolveRunDir(join(reports, 'missing'), reports)).toThrow('no run directory')
  })
})

describe('cli', () => {
  function evalEnv() {
    const fx = fixtureHome()
    const evalDir = mkdtempSync(join(tmpdir(), 'agw-eval-dir-'))
    return { fx, evalDir, env: { AGW_EVAL_DIR: evalDir, AGW_EVAL_HOME: fx.home, AGW_EVAL_PG_PASSWORD: 'x' } }
  }
  const fakeAgw =
    (counter: { agw: number }): Exec =>
    async (cmd, args, options) => {
      if (cmd === 'git') return exec(cmd, args, options)
      if (cmd === 'agw') {
        counter.agw++
        return {
          code: 0,
          stdout: JSON.stringify({ runId: `r${counter.agw}`, status: 'done', output: reviewOutput() }),
          stderr: '',
        }
      }
      return { code: 1, stdout: '', stderr: 'no journal in this test' }
    }

  test('--resume with a bare timestamp resolves under the reports dir; a bare name is a usage error that writes nothing', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const counter = { agw: 0 }
    const deps = (err: string[] = []) => ({
      env,
      exec: fakeAgw(counter),
      out: () => {},
      err: (l: string) => err.push(l),
    })
    expect(await main(['review'], deps())).toBe(0)
    const stamp = readdirSync(join(evalDir, 'reports'))[0] as string
    expect(counter.agw).toBe(1)

    expect(await main(['review', '--resume', stamp], deps())).toBe(0)
    expect(counter.agw).toBe(1) // resumed in <evalDir>/reports/<stamp>: the finished case was skipped
    expect(readdirSync(join(evalDir, 'reports'))).toEqual([stamp])

    const cwd = mkdtempSync(join(tmpdir(), 'agw-eval-cwd-'))
    const before = process.cwd()
    process.chdir(cwd)
    try {
      const err: string[] = []
      expect(await main(['review', '--resume', 'my-run'], deps(err))).toBe(2)
      expect(err.join('\n')).toContain('absolute path or a run timestamp')
      expect(await main(['review', '--resume', '2026-01-01T00-00-00-000Z'], deps(err))).toBe(2)
      expect(err.join('\n')).toContain('no run directory')
    } finally {
      process.chdir(before)
    }
    expect(readdirSync(cwd)).toEqual([])
    expect(readdirSync(join(evalDir, 'reports'))).toEqual([stamp])
  })

  test('self-agreement writes reproducibility.jsonl; review then counts the reproducible cases and says so', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const counter = { agw: 0 }
    const out: string[] = []
    const err: string[] = []
    const deps = { env, exec: fakeAgw(counter), out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
    expect(await main(['self-agreement', 'review', '--side', 'new', '--runs', '3'], deps)).toBe(0)
    expect(counter.agw).toBe(3)
    const file = join(evalDir, 'review', 'reproducibility.jsonl')
    expect(readRows(file)).toMatchObject([{ id: 'a', side: 'new', runs: 3, reproducible: true }])
    expect(out.join('\n')).toContain('1 of 1 measured cases reproducible')

    // Only the new side was measured: the baseline is legacy's, so the review run still has no data.
    out.length = 0
    expect(await main(['review'], deps)).toBe(0)
    expect(out.join('\n')).toContain('no reproducibility data')

    // A legacy row is what the baseline reads.
    writeLegacyRow(file, 'a', false)
    out.length = 0
    expect(await main(['review', '--resume', readdirSync(join(evalDir, 'reports'))[0] as string], deps)).toBe(0)
    expect(out.join('\n')).toContain('counted on 0 of 1 cases with a recorded blocking finding')
  })

  test('self-agreement rejects what does not apply, and a bad --side, --runs or --threshold', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'check', 'cases.jsonl'), CheckCase, [checkCase({ baseSha: fx.baseSha })])
    const err: string[] = []
    const counter = { agw: 0 }
    const run = (argv: string[]) => main(argv, { env, exec: fakeAgw(counter), out: () => {}, err: (l) => err.push(l) })
    expect(await run(['self-agreement', 'check', '--rerun-legacy'])).toBe(2)
    expect(await run(['self-agreement', 'check', '--dry-run'])).toBe(2)
    expect(await run(['self-agreement', 'check', '--resume', 'x'])).toBe(2)
    expect(err.join('\n')).toContain('self-agreement does not take')
    for (const bad of [
      ['--side', 'both'],
      ['--runs', '1'],
      ['--threshold', '1.5'],
    ]) {
      const failure = await run(['self-agreement', 'check', ...bad]).then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
    }
    expect(counter.agw).toBe(0)
    expect(existsSync(join(evalDir, 'check', 'reproducibility.jsonl'))).toBe(false)
  })
})

function writeLegacyRow(file: string, id: string, reproducible: boolean) {
  const row = { id, side: 'legacy', runs: 2, outcomeAgreement: 0.33, blockingRecall: 0, reproducible, threshold: 0.5 }
  appendFileSync(file, `${JSON.stringify(row)}\n`)
}
