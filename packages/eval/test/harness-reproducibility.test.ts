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
  appendRow,
  DEFAULT_THRESHOLD,
  isReproducible,
  readRows,
  type ReproducibilityRow,
  recordedSelfAgreement,
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

/** The measured rows as rows recorded while agent-gateway still ran: the only side `reproducibleCases` scores on. */
const asRecorded = (rows: ReproducibilityRow[]): ReproducibilityRow[] => rows.map((r) => ({ ...r, side: 'legacy' }))

function options(home: string, overrides: Partial<SelfAgreementOptions> = {}): SelfAgreementOptions {
  return {
    exec,
    home,
    concurrency: 1,
    keep: false,
    depthMode: 'matched',
    resultsPath: join(mkdtempSync(join(tmpdir(), 'agw-eval-repro-')), 'reproducibility.jsonl'),
    runs: 2,
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
      side: 'new',
      runs: 2,
      outcomeAgreement: 1,
      blockingRecall: 1,
    })
    // recorded actionable vs two clean reruns: 1 of 3 pairs agree; the recorded blocker is found in neither rerun
    expect(rows.find((r) => r.id === 'flaky')).toMatchObject({
      outcomeAgreement: 1 / 3,
      blockingRecall: 0,
    })
    expect(reproducibleCases(asRecorded(rows), DEFAULT_THRESHOLD)).toEqual({
      threshold: DEFAULT_THRESHOLD,
      byId: new Map([
        ['stable', true],
        ['flaky', false],
      ]),
    })
  })

  test('the rows hold raw numbers: a new threshold applies to the same file without measuring again', async () => {
    const fx = fixtureHome()
    const cases = [
      reviewCase({ id: 'flaky', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'stable', baseSha: fx.baseSha, diff: fx.diff }),
    ]
    const { runner, calls } = scripted([clean, clean, reviewOutput(), reviewOutput()])
    const opts = options(fx.home)
    await selfAgreementReview(cases, { runner }, opts)
    const rows = readRows(opts.resultsPath)
    expect(rows.every((r) => !('reproducible' in r) && !('threshold' in r))).toBe(true)
    // flaky: outcome agreement 1/3, recall 0 -> reproducible only at a threshold of 0
    const at = (threshold: number) => reproducibleCases(asRecorded(rows), threshold)?.byId
    expect(at(0.5)).toEqual(
      new Map([
        ['flaky', false],
        ['stable', true],
      ]),
    )
    expect(at(0)).toEqual(
      new Map([
        ['flaky', true],
        ['stable', true],
      ]),
    )
    expect(at(1)?.get('stable')).toBe(true)
    expect(isReproducible({ id: 'x', side: 'legacy', runs: 2, outcomeAgreement: 1, blockingRecall: 0.6 }, 0.7)).toBe(
      false,
    )
    // pending keys on side and runs only: no threshold, so a rerun with another one measures nothing
    await selfAgreementReview(cases, { runner }, opts)
    expect(calls).toHaveLength(4)
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
    })
    expect(isReproducible(readRows(opts.resultsPath)[0] as never, 0.5)).toBe(true)
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

  test('the new side gets the depth the legacy run recorded', async () => {
    const fx = fixtureHome()
    const cases = [reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff })]
    const next = scripted([])
    await selfAgreementReview(cases, { runner: next.runner }, options(fx.home, { runs: 3 }))
    expect(next.calls.map((c) => c.depth)).toEqual(['standard', 'standard', 'standard'])
  })

  test('legacy and new rows of one case are kept apart; the baseline reads the recorded legacy rows only', async () => {
    const fx = fixtureHome()
    const cases = [reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff })]
    const opts = options(fx.home)
    // a row measured while agent-gateway still ran: 1 of 3 outcome pairs agree, no blocker recovered
    appendRow(opts.resultsPath, { id: 'a', side: 'legacy', runs: 2, outcomeAgreement: 1 / 3, blockingRecall: 0 })
    await selfAgreementReview(cases, { runner: scripted([]).runner }, opts)
    const rows = readRows(opts.resultsPath)
    expect(rows.map((r) => [r.side, isReproducible(r, 0.5)])).toEqual([
      ['legacy', false],
      ['new', true],
    ])
    // a legacy row wins over the new row of the same case; either side alone is data
    expect(reproducibleCases(rows, 0.5)?.byId).toEqual(new Map([['a', false]]))
    expect(
      reproducibleCases(
        rows.filter((r) => r.side === 'new'),
        0.5,
      )?.byId,
    ).toEqual(new Map([['a', true]]))
    expect(reproducibleCases([], 0.5)).toBeNull()
    // the noise floor reads the legacy rows of the run's cases only
    expect(recordedSelfAgreement(rows, ['a'])).toEqual({ cases: 1, outcomeAgreement: 1 / 3, blockingRecall: 0 })
    expect(
      recordedSelfAgreement(
        rows.filter((r) => r.side === 'new'),
        ['a'],
      ),
    ).toBeNull()
    expect(recordedSelfAgreement(rows, ['other'])).toBeNull()
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
    })
    expect(rows.find((r) => r.id === 'green')).toMatchObject({ outcomeAgreement: 1, blockingRecall: null })
    expect(reproducibleCases(asRecorded(rows), 0.5)?.byId).toEqual(
      new Map([
        ['red', false],
        ['green', true],
      ]),
    )
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

  const repro = (entries: [string, boolean][], threshold = 0.5) => ({ threshold, byId: new Map(entries) })
  const reviewReport = (
    results: Awaited<ReturnType<typeof reviewResults>>,
    aggregate: ReturnType<typeof aggregateReview>,
  ) => ({
    workflow: 'review' as const,
    meta: meta(),
    aggregate,
    verdict: reviewVerdict(aggregate),
    results,
  })

  test('only reproducible cases count; the headline prints the counted numbers, not the totals', async () => {
    const results = await reviewResults()
    const all = aggregateReview(results)
    expect(all.blocking.recall).toBe(0.5)
    expect(all.blocking).toMatchObject({ basis: null, coverage: null })
    expect(renderAggregate(reviewReport(results, all))).toContain('Blocking recall vs legacy: 50.0% (1/2);')

    const only = aggregateReview(
      results,
      1,
      repro([
        ['a', true],
        ['b', false],
      ]),
    )
    expect(only.blocking.recall).toBe(1)
    expect(only.blocking.basis).toEqual({
      threshold: 0.5,
      withRecorded: 2,
      counted: 1,
      notReproducible: 1,
      matched: 1,
      reference: 1,
    })
    expect(reviewVerdict(only).criteria[0]).toMatchObject({ metric: 'blocking recall', value: 1 })

    const text = renderAggregate(reviewReport(results, only))
    expect(text).toContain('Blocking recall vs legacy: 100.0% (1/1 on reproducible cases);')
    expect(text).not.toContain('(1/2')
    expect(text).toContain(
      'Reproducibility (threshold 0.5): blocking recall counted on 1 of 2 cases with a recorded blocking finding (1/1); 1 not reproducible.',
    )
    expect(renderMarkdown(reviewReport(results, all))).toContain('no reproducibility data')
  })

  test('partial data is not used: every case counts and the report says how many the data covers', async () => {
    const results = await reviewResults()
    const partial = aggregateReview(results, 1, repro([['a', true]]))
    expect(partial.blocking.recall).toBe(0.5)
    expect(partial.blocking.basis).toBeNull()
    expect(partial.blocking.coverage).toEqual({ covered: 1, cases: 2 })
    expect(renderAggregate(reviewReport(results, partial))).toContain(
      'reproducibility data covers 1 of 2 cases: not used, blocking recall counts every case.',
    )
    // rows for cases outside the run do not count towards the coverage
    const stranger = aggregateReview(
      results,
      1,
      repro([
        ['a', true],
        ['elsewhere', false],
      ]),
    )
    expect(stranger.blocking.coverage).toEqual({ covered: 1, cases: 2 })
  })

  test('no reproducible case leaves the recall undecided instead of passing it', async () => {
    const results = await reviewResults()
    const none = aggregateReview(
      results,
      1,
      repro([
        ['a', false],
        ['b', false],
      ]),
    )
    expect(none.blocking.recall).toBeNull()
    expect(reviewVerdict(none).criteria[0]?.pass).toBeNull()
  })

  test('check: the failure recall counts reproducible red cases only, and says so in the headline', async () => {
    const fx = fixtureHome()
    const red = (id: string) =>
      checkCase({
        id,
        baseSha: fx.baseSha,
        legacy: { passed: false, steps: [{ name: 'check', passed: false }], costUsd: 0, costExact: true, wallMs: 1 },
      })
    const runner = (passed: boolean) => ({
      async check() {
        return { output: { passed, steps: [{ name: 'check', passed }], summary: '' }, spend }
      },
    })
    const results = await runCheck([red('x')], { next: runner(false) }, { ...options(fx.home) })
    const filtered = aggregateCheck(results, 1, repro([['x', false]]))
    expect(filtered.failureRecall.recall).toBeNull()
    expect(filtered.failureRecall.basis).toMatchObject({ withRecorded: 1, counted: 0, notReproducible: 1 })
    expect(aggregateCheck(results).failureRecall.recall).toBe(1)
    expect(checkVerdict(filtered).criteria[1]?.pass).toBeNull()

    // two red cases, the new side catches only the first: the filtered headline shows the counted case's own numbers
    let n = 0
    const twice = { check: () => runner(n++ !== 0).check() }
    const two = await runCheck([red('p'), red('q')], { next: twice }, { ...options(fx.home), concurrency: 1 })
    const aggregate = aggregateCheck(
      two,
      1,
      repro([
        ['p', true],
        ['q', false],
      ]),
    )
    expect(aggregate.failureRecall).toMatchObject({ caught: 1, legacyFailed: 2, recall: 1 })
    const report = {
      workflow: 'check' as const,
      meta: meta(),
      aggregate,
      verdict: checkVerdict(aggregate),
      results: two,
    }
    expect(renderAggregate(report)).toContain(
      'Legacy failure recall: 100.0% (1/1 legacy-red cases red on the new side, reproducible ones)',
    )
    const partial = aggregateCheck(two, 1, repro([['p', true]]))
    expect(partial.failureRecall.coverage).toEqual({ covered: 1, cases: 2 })
  })
})

const meta = () => ({
  startedAt: '2026-10-28T09:00:00.000Z',
  finishedAt: '2026-10-28T09:10:00.000Z',
  depthMode: 'matched' as const,
  judge: false,
  concurrency: 1,
  seed: 1,
})

describe('--resume', () => {
  test('an absolute path or a path under the reports dir resolves; a missing run or an escape is an error', () => {
    const reports = mkdtempSync(join(tmpdir(), 'agw-eval-reports-'))
    const stamp = '2026-10-28T09-00-00-000Z'
    mkdirSync(join(reports, stamp))
    mkdirSync(join(reports, 'archive', stamp), { recursive: true })
    expect(resolveRunDir(stamp, reports)).toBe(join(reports, stamp))
    expect(resolveRunDir(`./${stamp}`, reports)).toBe(join(reports, stamp))
    expect(resolveRunDir(`archive/${stamp}`, reports)).toBe(join(reports, 'archive', stamp))
    expect(resolveRunDir(join(reports, stamp), reports)).toBe(join(reports, stamp))
    expect(resolveRunDir(mkdtempSync(join(tmpdir(), 'agw-eval-abs-')), reports)).toContain('agw-eval-abs-')
    for (const missing of ['2026-10-29T09-00-00-000Z', 'run', `reports/${stamp}`, join(reports, 'missing')]) {
      expect(() => resolveRunDir(missing, reports)).toThrow('no run directory')
    }
    for (const outside of ['..', '../x', `archive/../../${stamp}`, '.']) {
      expect(() => resolveRunDir(outside, reports)).toThrow('leaves')
    }
  })
})

describe('cli', () => {
  function evalEnv() {
    const fx = fixtureHome()
    const evalDir = mkdtempSync(join(tmpdir(), 'agw-eval-dir-'))
    return { fx, evalDir, env: { AGW_EVAL_DIR: evalDir, AGW_EVAL_HOME: fx.home, AGW_EVAL_PG_PASSWORD: 'x' } }
  }
  /** git runs for real; `agw` answers with a review (or fails with `agwCode`); everything else (psql, secrets) is absent. */
  const fakeAgw =
    (counter: { agw: number }, agwCode = 0): Exec =>
    async (cmd, args, options) => {
      if (cmd === 'git') return exec(cmd, args, options)
      if (cmd === 'agw') {
        counter.agw++
        if (agwCode !== 0) return { code: agwCode, stdout: '', stderr: 'host down' }
        return {
          code: 0,
          stdout: JSON.stringify({ runId: `r${counter.agw}`, status: 'done', output: reviewOutput() }),
          stderr: '',
        }
      }
      return { code: 1, stdout: '', stderr: 'no journal in this test' }
    }

  test('--resume resolves a timestamp under the reports dir, never against the cwd', async () => {
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
    mkdirSync(join(cwd, 'my-run')) // a directory of that name in the cwd must not be picked up
    const before = process.cwd()
    process.chdir(cwd)
    try {
      const err: string[] = []
      expect(await main(['review', '--resume', 'my-run'], deps(err))).toBe(2)
      expect(err.join('\n')).toContain('no run directory')
      expect(await main(['review', '--resume', '../escape'], deps(err))).toBe(2)
      expect(err.join('\n')).toContain('leaves')
    } finally {
      process.chdir(before)
    }
    expect(readdirSync(join(cwd, 'my-run'))).toEqual([])
    expect(readdirSync(join(evalDir, 'reports'))).toEqual([stamp])
  })

  test('self-agreement writes raw rows; review reads the legacy rows at the --threshold given, without measuring again', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const counter = { agw: 0 }
    const out: string[] = []
    const err: string[] = []
    const deps = { env, exec: fakeAgw(counter), out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
    expect(await main(['self-agreement', 'review', '--runs', '3'], deps)).toBe(0)
    expect(counter.agw).toBe(3)
    const file = join(evalDir, 'review', 'reproducibility.jsonl')
    expect(readRows(file)).toMatchObject([{ id: 'a', side: 'new', runs: 3, outcomeAgreement: 1, blockingRecall: 1 }])
    expect(out.join('\n')).toContain('1 of 1 measured cases reproducible at threshold 0.5')

    // The new side's row feeds the gate, but it is no noise floor: the fixed floors apply.
    out.length = 0
    expect(await main(['review'], deps)).toBe(0)
    expect(out.join('\n')).toContain(
      'Reproducibility (threshold 0.5): blocking recall counted on 1 of 1 cases with a recorded blocking finding',
    )
    expect(out.join('\n')).toContain('Floor basis: fixed floors')

    // A legacy row (raw numbers: 1 of 3 outcome pairs agree, no blocker recovered) wins and gives the noise floor.
    appendFileSync(
      file,
      `${JSON.stringify({ id: 'a', side: 'legacy', runs: 2, outcomeAgreement: 0.33, blockingRecall: 0 })}\n`,
    )
    out.length = 0
    expect(await main(['review'], deps)).toBe(0)
    expect(out.join('\n')).toContain(
      'Reproducibility (threshold 0.5): blocking recall counted on 0 of 1 cases with a recorded blocking finding',
    )
    expect(out.join('\n')).toContain("Floor basis: legacy's recorded self-agreement (1 cases")
    const agwCalls = counter.agw
    out.length = 0
    expect(await main(['review', '--threshold', '0'], deps)).toBe(0)
    expect(out.join('\n')).toContain(
      'Reproducibility (threshold 0): blocking recall counted on 1 of 1 cases with a recorded blocking finding (1/1)',
    )
    expect(counter.agw).toBe(agwCalls + 1) // one review run since; the file was not measured again
  })

  test('self-agreement exits 1 when no case was measured; 0 when everything was measured before', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const err: string[] = []
    const out: string[] = []
    const run = (agwCode: number) =>
      main(['self-agreement', 'review'], {
        env,
        exec: fakeAgw({ agw: 0 }, agwCode),
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      })
    expect(await run(1)).toBe(1) // every rerun failed
    expect(out.join('\n')).toContain('measured 0, skipped 0, errored 1')
    expect(err.join('\n')).toContain('no case was measured')
    expect(existsSync(join(evalDir, 'review', 'reproducibility.jsonl'))).toBe(false)

    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'bad', baseSha: fx.baseSha, diff: BAD_DIFF }),
    ])
    expect(await run(0)).toBe(1) // every case skipped
    expect(out.join('\n')).toContain('measured 0, skipped 1, errored 0')

    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    expect(await run(0)).toBe(0)
    expect(await run(1)).toBe(0) // already measured: nothing to rerun, nothing failed
  })

  test('--runs outside self-agreement is a usage error; self-agreement rejects what does not apply', async () => {
    const { fx, evalDir, env } = evalEnv()
    writeCases(join(evalDir, 'check', 'cases.jsonl'), CheckCase, [checkCase({ baseSha: fx.baseSha })])
    writeCases(join(evalDir, 'review', 'cases.jsonl'), ReviewCase, [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
    ])
    const err: string[] = []
    const counter = { agw: 0 }
    const run = (argv: string[]) => main(argv, { env, exec: fakeAgw(counter), out: () => {}, err: (l) => err.push(l) })
    expect(await run(['check', '--runs', '3'])).toBe(2)
    expect(err.join('\n')).toContain('--runs applies to self-agreement only')
    expect(await run(['self-agreement', 'check', '--dry-run'])).toBe(2)
    expect(await run(['self-agreement', 'check', '--resume', 'x'])).toBe(2)
    expect(err.join('\n')).toContain('self-agreement does not take')
    for (const bad of [
      ['--side', 'legacy'],
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
