import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewAggregate } from '../src/harness/aggregate.ts'
import { classifyPair, matchFindings } from '../src/harness/match.ts'
import { exec } from '../src/harness/exec.ts'
import { cleanup, materialize, setupSteps } from '../src/harness/materialize.ts'
import { bootstrapMedianCI, median, ratioSummary } from '../src/harness/stats.ts'
import { checkVerdict, reviewVerdict } from '../src/harness/verdict.ts'
import { BAD_DIFF, fixtureHome } from './harness-support.ts'

describe('materialize', () => {
  test('clones at baseSha and applies the diff as uncommitted changes, without touching the source', async () => {
    const fx = fixtureHome()
    const tree = await materialize(
      { repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: fx.diff },
      { exec, home: fx.home, setup: false },
    )
    if (!tree.ok) throw new Error(tree.detail)
    expect(readFileSync(join(tree.dir, 'app.ts'), 'utf8')).toContain('b = 3')
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: tree.dir }).stdout.toString()
    expect(status).toContain('M app.ts')
    expect(readFileSync(join(fx.repo, 'app.ts'), 'utf8')).toContain('b = 2')
    cleanup(tree.dir)
    expect(existsSync(tree.dir)).toBe(false)
  })

  test('a diff that does not apply is apply_failed; a missing repo or sha is named', async () => {
    const fx = fixtureHome()
    const options = { exec, home: fx.home, setup: false }
    const bad = await materialize({ repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: BAD_DIFF }, options)
    expect(bad).toMatchObject({ ok: false, reason: 'apply_failed' })
    const missing = await materialize({ repo: 'SourceRoot/nope', baseSha: fx.baseSha }, options)
    expect(missing).toMatchObject({ ok: false, reason: 'repo_missing' })
    const sha = await materialize({ repo: 'SourceRoot/fixture', baseSha: 'f'.repeat(40) }, options)
    expect(sha).toMatchObject({ ok: false, reason: 'checkout_failed' })
  })

  test('setup runs bun install only when the Makefile check does not install itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-eval-setup-'))
    expect(setupSteps(dir)).toEqual([])
    writeFileSync(join(dir, 'bun.lock'), '{}')
    expect(setupSteps(dir)).toEqual(['bun install --frozen-lockfile'])
    writeFileSync(join(dir, 'Makefile'), 'check:\n\t@bun install --frozen-lockfile\n\t@bun test\n')
    expect(setupSteps(dir)).toEqual([])
  })
})

describe('matcher', () => {
  const ref = { file: 'src/a.ts', line: 10, message: 'Missing null check on user before reading user.email' }

  test('same file near the line with shared words matches', () => {
    expect(
      classifyPair(ref, { file: './src/a.ts', line: 14, message: 'user may be null: user.email throws' }).kind,
    ).toBe('match')
  })

  test('a different file never matches', () => {
    expect(classifyPair(ref, { file: 'src/b.ts', line: 10, message: ref.message }).kind).toBe('none')
  })

  test('line-less findings on the same file match on text', () => {
    const a = { file: 'README.md', message: 'Install section names the wrong command' }
    expect(classifyPair(a, { file: 'README.md', message: 'The install command in the section is wrong' }).kind).toBe(
      'match',
    )
  })

  test('near but different wording, or far with the same wording, is unsure', () => {
    expect(
      classifyPair(ref, { file: 'src/a.ts', line: 12, message: 'SQL query built by string concatenation' }).kind,
    ).toBe('unsure')
    expect(classifyPair(ref, { file: 'src/a.ts', line: 40, message: ref.message }).kind).toBe('unsure')
    expect(classifyPair(ref, { file: 'src/a.ts', message: ref.message }).kind).toBe('unsure')
    expect(classifyPair(ref, { file: 'src/a.ts', line: 40, message: 'unrelated wording entirely' }).kind).toBe('none')
  })

  test('one-to-one, and the judge decides only the unsure pairs', async () => {
    const candidate = [
      { file: 'src/a.ts', line: 11, message: 'user can be null; reading user.email crashes' },
      { file: 'src/a.ts', line: 11, message: 'null user email check missing' },
    ]
    const sure = await matchFindings([ref], candidate)
    expect(sure).toMatchObject({ matched: 1, judged: 0, unsure: 0 })

    const far = [{ file: 'src/a.ts', line: 80, message: ref.message }]
    expect(await matchFindings([ref], far)).toMatchObject({ matched: 0, unsure: 1 })
    let asked = 0
    const judge = {
      sameDefect: async () => {
        asked++
        return true
      },
    }
    expect(await matchFindings([ref], far, { judge, diff: 'd' })).toMatchObject({ matched: 1, judged: 1, unsure: 0 })
    expect(asked).toBe(1)
    await matchFindings([ref], candidate, { judge })
    expect(asked).toBe(1)
  })
})

describe('stats', () => {
  test('median', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  test('bootstrap CI is deterministic under a seed and brackets the median', () => {
    const values = [0.8, 0.9, 1.0, 1.05, 1.1, 1.2, 0.95, 1.3, 0.7, 1.0]
    const a = bootstrapMedianCI(values, { seed: 7 })
    expect(a).toEqual(bootstrapMedianCI(values, { seed: 7 }))
    const [lo, hi] = a as [number, number]
    expect(lo).toBeLessThanOrEqual(median(values) as number)
    expect(hi).toBeGreaterThanOrEqual(median(values) as number)
    expect(bootstrapMedianCI([1], { seed: 7 })).toBeNull()
  })

  test('ratios pair cases and drop the ones missing a side', () => {
    const r = ratioSummary(
      [
        { a: 2, b: 1 },
        { a: null, b: 1 },
        { a: 1, b: 0 },
        { a: 1, b: 2 },
        { a: 1, b: 1 },
      ],
      1,
    )
    expect(r.n).toBe(3)
    expect(r.median).toBe(1)
  })
})

function aggregate(overrides: Partial<ReviewAggregate> = {}): ReviewAggregate {
  const ratio = { n: 25, median: 1, ci95: [0.9, 1.1] as [number, number] }
  return {
    cases: { total: 25, ok: 25, errors: 0, skipped: {} },
    outcome: { agreement: 0.8, confusion: {} },
    blocking: { legacy: 20, new: 20, matched: 15, judged: 0, unsure: 0, recall: 0.75, newOnly: 5 },
    improvementsPerCase: { legacy: 3, new: 3 },
    needsHumanRate: { legacy: 0, new: 0 },
    failedAngleRate: { legacy: 0, new: 0 },
    cost: { ...ratio, baseline: 'recorded', newUsd: 1, legacyUsd: 1 },
    wall: { ...ratio, baseline: 'recorded' },
    selfAgreement: null,
    ...overrides,
  }
}

describe('verdict', () => {
  test('not worse when every criterion holds', () => {
    expect(reviewVerdict(aggregate()).verdict).toBe('not-worse')
  })

  test('worse names the failing metric', () => {
    const v = reviewVerdict(aggregate({ cost: { ...aggregate().cost, median: 1.3 } }))
    expect(v.verdict).toBe('worse')
    expect(v.reasons.join()).toContain('median cost ratio')
  })

  test('the floor is legacy self-agreement minus the margin when a rerun measured it', () => {
    const blocking = { ...aggregate().blocking, recall: 0.75 }
    const strict = aggregate({ blocking, selfAgreement: { cases: 25, blockingRecall: 0.9, outcomeAgreement: 0.85 } })
    const v = reviewVerdict(strict)
    expect(v.verdict).toBe('worse')
    expect(v.criteria[0]?.threshold).toBeCloseTo(0.8)
    const lax = aggregate({ selfAgreement: { cases: 25, blockingRecall: 0.7, outcomeAgreement: 0.7 } })
    expect(reviewVerdict(lax).verdict).toBe('not-worse')
  })

  test('inconclusive below the case minimum or without data', () => {
    expect(reviewVerdict(aggregate({ cases: { total: 19, ok: 19, errors: 0, skipped: {} } })).verdict).toBe(
      'inconclusive',
    )
    const noCost = aggregate({ cost: { ...aggregate().cost, median: null, n: 0 } })
    expect(reviewVerdict(noCost)).toMatchObject({ verdict: 'inconclusive', reasons: ['median cost ratio: no data'] })
  })

  test('check: passed agreement against its own floor, minimum 5 cases', () => {
    const ratio = { n: 5, median: 1, ci95: null }
    const check = {
      cases: { total: 5, ok: 5, errors: 0, skipped: {} },
      passed: { agreement: 1, confusion: { legacyPass: { pass: 5, fail: 0 }, legacyFail: { pass: 0, fail: 0 } } },
      steps: { compared: 5, agreement: 1 },
      cost: { ...ratio, baseline: 'recorded' as const, newUsd: 0, legacyUsd: 0 },
      wall: { ...ratio, baseline: 'recorded' as const },
      selfAgreement: null,
    }
    expect(checkVerdict(check).verdict).toBe('not-worse')
    expect(checkVerdict({ ...check, passed: { ...check.passed, agreement: 0.8 } }).verdict).toBe('worse')
    expect(checkVerdict({ ...check, cases: { ...check.cases, ok: 4 } }).verdict).toBe('inconclusive')
  })
})
