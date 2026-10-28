import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateCheck, aggregateReview } from '../src/harness/aggregate.ts'
import { exec } from '../src/harness/exec.ts'
import { AGGREGATE_HEADING, PRIVATE_HEADING, renderMarkdown } from '../src/harness/report.ts'
import { type HarnessOptions, runCheck, runReview } from '../src/harness/run.ts'
import { reviewVerdict } from '../src/harness/verdict.ts'
import { BAD_DIFF, checkCase, fakeCheck, fakeReview, fixtureHome, reviewCase, reviewOutput } from './harness-support.ts'

function options(home: string, overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    exec,
    home,
    concurrency: 2,
    keep: false,
    depthMode: 'matched',
    resultsPath: join(mkdtempSync(join(tmpdir(), 'agw-eval-run-')), 'results.jsonl'),
    ...overrides,
  }
}

describe('runReview', () => {
  test('runs the new side on the materialized tree with the legacy depth; an unapplicable diff is counted', async () => {
    const fx = fixtureHome()
    const cases = [
      reviewCase({ id: 'good', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'bad', baseSha: fx.baseSha, diff: BAD_DIFF }),
    ]
    const next = fakeReview(reviewOutput())
    const results = await runReview(cases, { next: next.runner }, options(fx.home))
    expect(next.calls).toHaveLength(1)
    expect(next.calls[0]?.depth).toBe('standard')
    expect(results.find((r) => r.id === 'bad')).toMatchObject({ status: 'skipped', reason: 'apply_failed' })
    const good = results.find((r) => r.id === 'good')
    expect(good).toMatchObject({ status: 'ok', match: { reference: 1, matched: 1, newOnly: 0 } })

    const agg = aggregateReview(results)
    expect(agg.cases).toEqual({ total: 2, ok: 1, errors: 0, skipped: { apply_failed: 1 } })
    expect(agg.blocking.recall).toBe(1)
    expect(agg.outcome.agreement).toBe(1)
  })

  test('router depth mode leaves the depth to the new side', async () => {
    const fx = fixtureHome()
    const next = fakeReview(reviewOutput())
    await runReview(
      [reviewCase({ baseSha: fx.baseSha, diff: fx.diff })],
      { next: next.runner },
      options(fx.home, { depthMode: 'router' }),
    )
    expect(next.calls[0]?.depth).toBeUndefined()
  })

  test('resume skips finished cases and retries failed ones', async () => {
    const fx = fixtureHome()
    const cases = ['a', 'b', 'c'].map((id) => reviewCase({ id, baseSha: fx.baseSha, diff: fx.diff }))
    const opts = options(fx.home)
    let fail = true
    let calls = 0
    const flaky = {
      async review() {
        calls++
        if (fail && calls === 2) throw new Error('host down')
        return { output: reviewOutput(), spend: { costUsd: 0.04, costExact: true, wallMs: 1 } }
      },
    }
    const first = await runReview(cases, { next: flaky }, { ...opts, concurrency: 1 })
    expect(first.map((r) => r.status)).toEqual(['ok', 'error', 'ok'])
    fail = false
    calls = 0
    const second = await runReview(cases, { next: flaky }, { ...opts, concurrency: 1 })
    expect(calls).toBe(1)
    expect(second.every((r) => r.status === 'ok')).toBe(true)
    expect(readFileSync(opts.resultsPath, 'utf8').trim().split('\n')).toHaveLength(4)
  })

  test('the legacy rerun gives the self-agreement floor, and a failed rerun keeps the case', async () => {
    const fx = fixtureHome()
    const cases = [
      reviewCase({ id: 'a', baseSha: fx.baseSha, diff: fx.diff }),
      reviewCase({ id: 'b', baseSha: fx.baseSha, diff: fx.diff }),
    ]
    let n = 0
    const legacy = {
      async review() {
        if (++n === 2) throw new Error('legacy down')
        return { output: reviewOutput({ blocking: [] }), spend: { costUsd: 0.05, costExact: false, wallMs: 90_000 } }
      },
    }
    const results = await runReview(
      cases,
      { next: fakeReview(reviewOutput()).runner, legacy },
      options(fx.home, { concurrency: 1 }),
    )
    expect(results.find((r) => r.rerun)?.rerun?.self).toMatchObject({ reference: 1, matched: 0 })
    expect(results.find((r) => r.rerunError)?.rerunError).toBe('legacy down')
    const agg = aggregateReview(results)
    expect(agg.selfAgreement).toMatchObject({ cases: 1, blockingRecall: 0, outcomeAgreement: 1 })
    expect(agg.cost.baseline).toBe('mixed')
  })
})

describe('runCheck', () => {
  test('passed agreement over materialized cases', async () => {
    const fx = fixtureHome()
    const cases = [
      checkCase({ id: 'green', baseSha: fx.baseSha, patch: fx.diff }),
      checkCase({
        id: 'red',
        baseSha: fx.baseSha,
        legacy: { ...checkCase({ baseSha: fx.baseSha }).legacy, passed: false },
      }),
    ]
    const next = fakeCheck(true)
    const results = await runCheck(cases, { next: next.runner }, options(fx.home))
    expect(next.calls()).toBe(2)
    const agg = aggregateCheck(results)
    expect(agg.passed.agreement).toBe(0.5)
    expect(agg.passed.confusion.legacyFail.pass).toBe(1)
  })
})

describe('report', () => {
  test('the aggregate section holds no message text, no path and no repo name', async () => {
    const fx = fixtureHome()
    const secret = 'Leaky secret finding about the credentials table'
    const cases = [
      reviewCase({
        id: 'iu',
        repo: 'IuRoot/private-service',
        baseSha: fx.baseSha,
        diff: fx.diff,
        legacy: {
          ...reviewCase({ baseSha: fx.baseSha, diff: fx.diff }).legacy,
          findings: [{ severity: 'blocking', file: 'src/secret/path.ts', line: 4, message: secret, angle: 'security' }],
        },
      }),
    ]
    // The fixture repo stands in for the private one.
    const results = await runReview(
      cases.map((c) => ({ ...c, repo: 'SourceRoot/fixture' })),
      {
        next: fakeReview(
          reviewOutput({
            blocking: [{ file: 'lib/other/place.ts', line: 1, message: 'New-only private message', angle: 'x' }],
          }),
        ).runner,
      },
      options(fx.home),
    )
    const withRepo = results.map((r) => ({ ...r, repo: 'IuRoot/private-service' }))
    const aggregate = aggregateReview(withRepo)
    const now = '2026-10-28T00:00:00.000Z'
    const md = renderMarkdown({
      meta: {
        workflow: 'review',
        startedAt: now,
        finishedAt: now,
        depthMode: 'matched',
        rerunLegacy: false,
        judge: false,
        concurrency: 2,
        seed: 1,
      },
      aggregate,
      verdict: reviewVerdict(aggregate),
      results: withRepo,
    })
    const start = md.indexOf(AGGREGATE_HEADING)
    const end = md.indexOf(PRIVATE_HEADING)
    expect(start).toBeGreaterThanOrEqual(0)
    const publishable = md.slice(start, end)
    for (const leak of [secret, 'New-only private message', 'src/secret/path.ts', 'lib/other', 'private-service']) {
      expect(publishable).not.toContain(leak)
    }
    expect(publishable).toContain('Blocking recall vs legacy: 0.0%')
    expect(md.slice(end)).toContain(secret)
  })
})
