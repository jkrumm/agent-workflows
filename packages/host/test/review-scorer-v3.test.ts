import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JUDGE_VERSION } from '@agent-workflows/capabilities'
import { GT_LIMIT, type GtCase, gtPath, type JudgeClass, type JudgeInput } from '@agent-workflows/eval'
import type { Json, ScorerContext } from '@agent-workflows/runtime'
import { readSuite } from '../src/workflows/eval/suites.ts'
import { hostModules, suitesOf } from '../src/workflows/index.ts'
import { createReviewScorer, judgeModeOf, reviewScorer as hostScorer } from '../src/workflows/review/scorer.ts'
import { applyVerdictRules, balanceDegradedVerdict } from '../src/workflows/review/verdict.ts'

/** The scorer in single-judge mode (a calibration that clears the bar); dual mode has its own tests below. */
const reviewScorer = createReviewScorer({ mode: 'single', kappa: 0.91 })
const NOTE = `judges: single (a), κ 0.91 between the judges; limit: ${GT_LIMIT}`

const HOST_SUITES = suitesOf(await hostModules())
const signal = new AbortController().signal
const input = { cwd: '/tmp/repo' }
const ZEROS = '0'.repeat(40)

let home: string
let sha: string
const originalHome = process.env.HOME

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString())
  return ran.stdout.toString().trim()
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agw-scorer-home-'))
  const repo = join(home, 'SourceRoot', 'fixture')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'cart.ts'), 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b)\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'feat: cart total')
  sha = git(repo, 'rev-parse', 'HEAD')
  process.env.HOME = home
})
afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const bugCase = (): GtCase => ({
  id: 'fixture-bug',
  kind: 'bug',
  split: 'dev',
  repo: 'SourceRoot/fixture',
  sha,
  parent: ZEROS,
  subject: 'feat: cart total',
  minerVersion: 'm1',
  candidateId: 'fixture-bug',
  bug: {
    location: { file: 'src/cart.ts', startLine: 1, endLine: 1 },
    description: 'reduce without an initial value throws on an empty cart',
    bugClass: 'edge-case',
    severity: 'major',
    fixSha: sha,
    fixSubject: 'fix: empty cart',
  },
})
const controlCase = (): GtCase => ({
  id: 'fixture-control',
  kind: 'control',
  split: 'test',
  repo: 'SourceRoot/fixture',
  sha,
  parent: ZEROS,
  subject: 'feat: cart total',
  minerVersion: 'm1',
})

type Finding = { file: string; line?: number; message: string; angle: string }
const f = (file: string, message: string, line?: number): Finding => ({
  file,
  message,
  angle: 'senior-dev',
  ...(line === undefined ? {} : { line }),
})
const review = (blocking: Finding[], improvements: Finding[] = [], discussions: Finding[] = []) => ({
  ...applyVerdictRules(
    {
      outcome: blocking.length ? ('actionable' as const) : ('clean' as const),
      blocking,
      improvements,
      discussions,
      testGaps: [],
      summary: 'x',
    },
    [],
    6,
  ).verdict,
  schemaVersion: 2,
})

/** A judge that answers from `classes` by finding id (default `unclear`), and records every call. */
function fakeJudge(classes: Record<string, JudgeClass>) {
  const calls: { capability: string; input: JudgeInput }[] = []
  const judge = async (capability: string, raw: Json): Promise<Json> => {
    const judgeInput = raw as unknown as JudgeInput
    calls.push({ capability, input: judgeInput })
    return {
      findings: judgeInput.findings.map((x) => ({ id: x.id, class: classes[x.id] ?? 'unclear', reason: `r${x.id}` })),
      model: 'fake',
    }
  }
  return { judge, calls }
}

const ctx = (reference: GtCase | undefined, judge?: ScorerContext<GtCase>['judge']): ScorerContext<GtCase> => ({
  source: reference ? 'regression' : 'drift',
  signal,
  ...(reference ? { reference } : {}),
  ...(judge ? { judge } : {}),
})

describe('review scorer v3: bug case', () => {
  test('an important finding judged match: recall 1, detected 1, calibrated', async () => {
    const { judge, calls } = fakeJudge({ '0': 'match', '1': 'not-a-bug', '2': 'real' })
    const out = review(
      [f('src/cart.ts', 'reduce on an empty array throws', 1)],
      [f('src/other.ts', 'rename', 4)],
      [f('src/x.ts', 'real elsewhere')],
    )
    const verdict = await reviewScorer.score(input, out, ctx(bugCase(), judge))
    expect(verdict.scores).toEqual({
      valid: 1,
      complete: 1,
      angleSuccess: 1,
      findings: 3,
      important: 1,
      realOther: 1,
      noise: 1 / 3,
      recall: 1,
      detected: 1,
      severityCalibration: 1,
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.feedback).toBe(`matched finding 0: r0; ${NOTE}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.capability).toBe('eval.judge')
    expect(calls[0]?.input.diff).toContain('+export const total')
    expect(calls[0]?.input.bug?.description).toContain('reduce without an initial value')
  })

  test('matched only as a nit: recall 0, detected 1, severityCalibration 0', async () => {
    const { judge } = fakeJudge({ '0': 'match' })
    const out = review([], [f('src/cart.ts', 'reduce needs an initial value', 1)])
    const verdict = await reviewScorer.score(input, out, ctx(bugCase(), judge))
    expect(verdict.scores).toMatchObject({ recall: 0, detected: 1, severityCalibration: 0 })
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toBe(`matched finding 0 (only as a nit): r0; ${NOTE}`)
  })

  test('missed: recall 0, detected 0, no calibration, the feedback names the bug', async () => {
    const { judge } = fakeJudge({ '0': 'not-a-bug' })
    const out = review([f('src/cart.ts', 'unrelated style complaint', 9)])
    const verdict = await reviewScorer.score(input, out, ctx(bugCase(), judge))
    expect(verdict.scores).toMatchObject({ recall: 0, detected: 0, noise: 1, important: 1 })
    expect(verdict.scores.severityCalibration).toBeUndefined()
    expect(verdict.feedback).toBe(`missed: edge-case at src/cart.ts:1; ${NOTE}`)
    expect(verdict.pass).toBe(false)
  })

  test('no findings: recall 0, no noise, no judge call', async () => {
    const { judge, calls } = fakeJudge({})
    const verdict = await reviewScorer.score(input, review([]), ctx(bugCase(), judge))
    expect(verdict.scores).toMatchObject({ recall: 0, detected: 0, findings: 0, important: 0, realOther: 0 })
    expect(verdict.scores.noise).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('preselection: same file, or a message naming the file; pipeline entries are no findings', async () => {
    const { judge, calls } = fakeJudge({})
    const out = review(
      [f('./src/cart.ts', 'a'), f('a/src/cart.ts', 'b', 40), f('lib/other.ts', 'cart.ts mishandles an empty list')],
      [f('lib/else.ts', 'unrelated')],
      [f('(review pipeline)', 'reviewer qa failed')],
    )
    await reviewScorer.score(input, out, ctx(bugCase(), judge))
    const sent = calls[0]?.input
    expect(sent?.findings.map((x) => [x.id, x.tag])).toEqual([
      ['0', 'important'],
      ['1', 'important'],
      ['2', 'important'],
      ['3', 'nit'],
    ])
    expect(sent?.preselected).toEqual(['0', '1', '2'])
    expect(sent?.findings[0]).not.toHaveProperty('line')
    expect(sent?.findings[1]).toMatchObject({ line: 40 })
  })
})

describe('review scorer v3: control', () => {
  test('two important findings: falseAlarms 2, clean 0', async () => {
    const { judge, calls } = fakeJudge({ '0': 'real', '1': 'not-a-bug' })
    const out = review([f('a.ts', 'x', 1), f('b.ts', 'y')])
    const verdict = await reviewScorer.score(input, out, ctx(controlCase(), judge))
    expect(verdict.scores).toMatchObject({ falseAlarms: 2, clean: 0, noise: 0.5, realOther: 1, findings: 2 })
    expect(verdict.scores.recall).toBeUndefined()
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toBe(`false alarms: 2 important findings; ${NOTE}`)
    expect(calls[0]?.input).toMatchObject({ bug: null, preselected: [] })
  })

  test('nits only is clean; no findings is clean without a judge call', async () => {
    const { judge, calls } = fakeJudge({})
    const nits = await reviewScorer.score(input, review([], [f('a.ts', 'n')]), ctx(controlCase(), judge))
    expect(nits.scores).toMatchObject({ falseAlarms: 0, clean: 1, noise: 0 })
    expect(nits.pass).toBe(true)
    const none = await reviewScorer.score(input, review([]), ctx(controlCase(), judge))
    expect(none.scores).toMatchObject({ falseAlarms: 0, clean: 1, findings: 0 })
    expect(none.scores.noise).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).not.toHaveProperty('seat')
  })
})

describe('review scorer v3: edges', () => {
  test('drift (no reference): structural scores only, no judge call', async () => {
    const { judge, calls } = fakeJudge({})
    const verdict = await reviewScorer.score(input, review([f('src/cart.ts', 'm')]), ctx(undefined, judge))
    expect(verdict).toEqual({ scores: { valid: 1, complete: 1, angleSuccess: 1 }, pass: true })
    expect(calls).toHaveLength(0)
  })

  test('invalid output: recall 0 for a bug, falseAlarms 0 and clean 0 for a control', async () => {
    const bug = await reviewScorer.score(input, { nope: true }, ctx(bugCase()))
    expect(bug).toEqual({
      scores: { valid: 0, complete: 0, angleSuccess: 0, recall: 0 },
      pass: false,
      feedback: 'the output is not REVIEW_OUTPUT v2',
    })
    const control = await reviewScorer.score(input, null, ctx(controlCase()))
    expect(control).toEqual({
      scores: { valid: 0, complete: 0, angleSuccess: 0, falseAlarms: 0, clean: 0 },
      pass: false,
      feedback: 'the run failed',
    })
  })

  test('a stand-in verdict never passes, even clean', async () => {
    const verdict = await reviewScorer.score(input, balanceDegradedVerdict([]), ctx(controlCase(), fakeJudge({}).judge))
    expect(verdict.scores).toMatchObject({ complete: 0, clean: 1 })
    expect(verdict.pass).toBe(false)
  })

  test('the reference is validated as a ground-truth case', () => {
    expect(reviewScorer.reference?.safeParse(bugCase()).success).toBe(true)
    expect(reviewScorer.reference?.safeParse({ outcome: 'clean', blocking: [] }).success).toBe(false)
    expect(reviewScorer.version).toBe(`2026-11-03.v4+${JUDGE_VERSION}+judges:single`)
    expect(createReviewScorer({ mode: 'dual', kappa: null }).version).toBe(`2026-11-03.v4+${JUDGE_VERSION}+judges:dual`)
  })
})

/** A judge per seat: `a` answers `classesA`, `b` answers `classesB`; every call is recorded with its seat. */
function twoJudges(classesA: Record<string, JudgeClass>, classesB: Record<string, JudgeClass>) {
  const calls: JudgeInput[] = []
  const judge = async (_capability: string, raw: Json): Promise<Json> => {
    const judgeInput = raw as unknown as JudgeInput
    calls.push(judgeInput)
    const classes = judgeInput.seat === 'b' ? classesB : classesA
    return {
      findings: judgeInput.findings.map((x) => ({
        id: x.id,
        class: classes[x.id] ?? 'unclear',
        reason: `${judgeInput.seat ?? 'a'}${x.id}`,
      })),
      model: 'fake',
    }
  }
  return { judge, calls }
}

describe('review scorer v3: both judges', () => {
  const dual = createReviewScorer({ mode: 'dual', kappa: 0.5 })

  test('asks seat a (as always) and seat b on the same input; agreement stands, the note says the mode and the limit', async () => {
    const { judge, calls } = twoJudges({ '0': 'match', '1': 'nit' }, { '0': 'match', '1': 'nit' })
    const out = review([f('src/cart.ts', 'reduce on an empty array throws', 1)], [f('src/other.ts', 'rename', 4)])
    const verdict = await dual.score(input, out, ctx(bugCase(), judge))
    expect(calls.map((c) => c.seat)).toEqual([undefined, 'b'])
    expect(calls[1]).toEqual({ ...(calls[0] as JudgeInput), seat: 'b' })
    expect(verdict.scores).toMatchObject({ recall: 1, detected: 1 })
    expect(verdict.pass).toBe(true)
    expect(verdict.feedback).toBe(
      `matched finding 0: a0; judges: dual, 0 findings judged differently, scored unclear; limit: ${GT_LIMIT}`,
    )
  })

  test('a finding the judges classify differently is unclear: a split match is no match', async () => {
    const { judge } = twoJudges({ '0': 'match', '1': 'real' }, { '0': 'real', '1': 'real' })
    const out = review([f('src/cart.ts', 'reduce on an empty array throws', 1)], [f('src/other.ts', 'a real one', 4)])
    const verdict = await dual.score(input, out, ctx(bugCase(), judge))
    expect(verdict.scores).toMatchObject({ recall: 0, detected: 0, realOther: 1, noise: 0 })
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toContain('judges: dual, 1 finding judged differently, scored unclear')
  })

  test('a control: a split verdict on an important finding is unclear, still a false alarm', async () => {
    const { judge } = twoJudges({ '0': 'not-a-bug' }, { '0': 'nit' })
    const verdict = await dual.score(input, review([f('a.ts', 'x', 1)]), ctx(controlCase(), judge))
    expect(verdict.scores).toMatchObject({ falseAlarms: 1, clean: 0, noise: 0, realOther: 0 })
  })

  test('no findings: no judge call and no mode note', async () => {
    const { judge, calls } = twoJudges({}, {})
    const verdict = await dual.score(input, review([]), ctx(bugCase(), judge))
    expect(calls).toHaveLength(0)
    expect(verdict.feedback).toBe('missed: edge-case at src/cart.ts:1')
  })

  test('a failing second judge fails the scoring (retried by the runtime), never a single-judge score', async () => {
    const judge = async (_c: string, raw: Json): Promise<Json> => {
      if ((raw as unknown as JudgeInput).seat === 'b') throw new Error('judge b is down')
      return { findings: [{ id: '0', class: 'match', reason: 'r' }], model: 'fake' }
    }
    const outcome = await Promise.resolve(
      dual.score(input, review([f('src/cart.ts', 'm', 1)]), ctx(bugCase(), judge)),
    ).then(
      () => null,
      (error: Error) => error,
    )
    expect(outcome?.message).toBe('judge b is down')
  })
})

describe('review scorer: the mode follows the calibration file', () => {
  const calibration = (over: Record<string, unknown> = {}) => ({
    at: '2026-11-03T10:00:00.000Z',
    limit: GT_LIMIT,
    judgeVersion: JUDGE_VERSION,
    judgeModels: { a: ['m-a'], b: ['m-b'] },
    evalRuns: ['r1'],
    n: 100,
    agreement: 0.95,
    kappa: 0.9,
    ci95: { lo: 0.8, hi: 0.97 },
    bar: 0.8,
    met: true,
    confusion: { yy: 48, yn: 2, ny: 3, nn: 47 },
    classes: { n: 0, agreement: null, confusion: {} },
    ...over,
  })
  const modeWith = (content: unknown | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-calibration-'))
    const env = { AGW_EVAL_DIR: dir }
    if (content !== null) {
      mkdirSync(join(dir, 'review-gt'))
      writeFileSync(
        gtPath('judge-calibration.json', env),
        typeof content === 'string' ? content : JSON.stringify(content),
      )
    }
    const mode = judgeModeOf(env)
    rmSync(dir, { recursive: true, force: true })
    return mode
  }

  test('single judge only for a calibration of this judge version with κ at or above the bar', () => {
    expect(modeWith(calibration())).toEqual({ mode: 'single', kappa: 0.9 })
    expect(modeWith(calibration({ kappa: 0.8 }))).toMatchObject({ mode: 'single' })
  })

  test('both judges when it is missing, unreadable, below the bar, undefined or of another judge version', () => {
    expect(modeWith(null)).toEqual({ mode: 'dual', kappa: null })
    expect(modeWith('not json')).toEqual({ mode: 'dual', kappa: null })
    expect(modeWith({ kappa: 0.99 })).toEqual({ mode: 'dual', kappa: null })
    expect(modeWith(calibration({ kappa: 0.79, met: false }))).toEqual({ mode: 'dual', kappa: 0.79 })
    expect(modeWith(calibration({ kappa: null, met: false }))).toMatchObject({ mode: 'dual' })
    expect(modeWith(calibration({ judgeVersion: 'eval-judge-old' }))).toMatchObject({ mode: 'dual' })
  })

  test('the scorer the host runs resolves it once, with the mode in its version', () => {
    expect(hostScorer.version).toMatch(/^2026-11-03\.v4\+eval-judge-[0-9a-f]{12}\+judges:(single|dual)$/)
  })
})

describe('review suite', () => {
  test('reads the ground-truth cases from review-gt, isolated, reviewed as the last commit', () => {
    const evalDir = mkdtempSync(join(tmpdir(), 'agw-gt-eval-'))
    const env = { AGW_EVAL_DIR: evalDir }
    const path = gtPath('cases.jsonl', env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${[bugCase(), controlCase()].map((c) => JSON.stringify(c)).join('\n')}\n`)
    // a legacy cases file beside it must stay unread
    mkdirSync(join(evalDir, 'review'))
    writeFileSync(join(evalDir, 'review', 'cases.jsonl'), 'not json\n')

    const cases = readSuite(HOST_SUITES, 'review', env)
    expect(cases.map((c) => c.id)).toEqual(['fixture-bug', 'fixture-control'])
    expect(cases[0]).toMatchObject({
      tree: { repo: 'SourceRoot/fixture', baseSha: sha, isolate: true },
      setup: false,
      reference: bugCase(),
    })
    expect(cases[0]?.tree).not.toHaveProperty('patch')
    expect(cases[0]?.input('/tmp/clone', {})).toEqual({ cwd: '/tmp/clone', scope: 'head', context: 'feat: cart total' })
    expect(cases[0]?.input('/tmp/clone', { depth: 'deep' })).toMatchObject({ depth: 'deep', scope: 'head' })
    expect(reviewScorer.reference?.safeParse(cases[1]?.reference).success).toBe(true)
    rmSync(evalDir, { recursive: true, force: true })
  })
})
