import { JUDGE_B_VERSION, JUDGE_VERSION } from '@agent-workflows/capabilities'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GT_LIMIT,
  type GtCase,
  gtPath,
  type JudgeClass,
  type JudgeInput,
  type JudgeOutput,
} from '@agent-workflows/eval'
import {
  createEvalRecall,
  type RecallJudge,
  type RecallReview,
  selectCases,
  evalRecallInput,
} from '../src/workflows/eval-recall/index.ts'
import type { RecallClones } from '../src/workflows/eval-recall/clones.ts'
import { summarize } from '../src/workflows/eval-recall/summary.ts'
import type { OutputFindingValue } from '../src/review/schema.ts'
import { type Body, startTestHost, type TestHost } from './support.ts'

const SHA = (n: number) => String(n).repeat(40).slice(0, 40)
const DESCRIPTION = 'The loop runs once too often (SECRET-BUG-DESCRIPTION).'

const bugCase = (id: string, split: 'dev' | 'test' = 'dev'): GtCase => ({
  id,
  kind: 'bug',
  split,
  repo: 'SourceRoot/demo',
  sha: SHA(2),
  parent: SHA(1),
  subject: `feat: ${id}`,
  minerVersion: 'm1',
  candidateId: id,
  bug: {
    location: { file: 'src/a.ts', startLine: 2, endLine: 3 },
    description: DESCRIPTION,
    bugClass: 'logic',
    severity: 'major',
    fixSha: SHA(3),
    fixSubject: 'fix: bound',
  },
})
const controlCase = (id: string, split: 'dev' | 'test' = 'dev'): GtCase => ({
  id,
  kind: 'control',
  split,
  repo: 'SourceRoot/demo',
  sha: SHA(2),
  parent: SHA(1),
  subject: `chore: ${id}`,
  minerVersion: 'm1',
})

const finding = (id: string, tag: OutputFindingValue['tag'], file = 'src/a.ts'): OutputFindingValue => ({
  id,
  tag,
  class: 'bug',
  file,
  line: 2,
  message: `finding ${id}`,
  failureScenario: 'it breaks',
})

type Fate =
  | { kind: 'gave-up'; state: string }
  | { kind: 'waiting' }
  | { kind: 'submit'; findings: OutputFindingValue[] }
  | { kind: 'abandon' }
  | { kind: 'needs-human' }

/** The review service port: jobs by clone dir, a case's fate by its subject; a job is submitted at its first poll. */
function fakeReview(fates: Record<string, Fate>) {
  const requests: Record<string, unknown>[] = []
  const cancels: string[] = []
  const jobs = new Map<string, { id: string; cwd: string; fate: Fate; polls: number; cancelled?: boolean }>()
  const state = (job: { fate: Fate; polls: number; cancelled?: boolean }) => {
    if (job.fate.kind === 'abandon' || job.cancelled) return 'abandoned'
    if (job.fate.kind === 'gave-up') return 'prepared' // the factory ended a2; nothing will ever submit
    if (job.fate.kind === 'waiting') return job.polls > 3 ? 'submitted' : 'prepared' // held by the ceiling a while
    return job.polls > 0 ? 'submitted' : 'prepared'
  }
  const review = {
    async request(input: Parameters<RecallReview['request']>[0]) {
      requests.push(input)
      const fate = fates[input.context ?? ''] ?? { kind: 'submit', findings: [] }
      if (fate.kind === 'needs-human')
        return { status: 'needs-human', reason: 'round 4', thread: 't', round: 4, base: 'b', head: 'h', account: null }
      const id = `rv_${jobs.size + 1}`
      jobs.set(id, { id, cwd: input.cwd, fate, polls: 0 })
      return {
        status: 'requested',
        jobId: id,
        tier: 'light',
        thread: 't',
        round: 1,
        base: 'b',
        head: 'h',
        account: null,
      }
    },
    async status(input: Parameters<RecallReview['status']>[0]) {
      if (input.cwd) {
        return {
          jobs: [...jobs.values()]
            .filter((job) => job.cwd === input.cwd)
            .map((job) => ({
              id: job.id,
              state: state(job),
              tier: 'light',
              transport: 'hidden',
              thread: 't',
              round: 1,
            })),
        }
      }
      const job = jobs.get(input.jobId as string)
      if (!job) throw new Error(`unknown job ${input.jobId}`)
      job.polls++
      const submitted = state(job) === 'submitted'
      return {
        job: {
          id: job.id,
          state: state(job),
          tier: 'light',
          seat: { model: 'sonnet', effort: 'low' },
          account: 'max-b',
          createdAt: '2026-11-03T10:00:00.000Z',
          submittedAt: submitted ? '2026-11-03T10:07:00.000Z' : null,
          output: submitted ? { findings: job.fate.kind === 'submit' ? job.fate.findings : [] } : null,
          ...(state(job) === 'prepared'
            ? {
                hidden:
                  job.fate.kind === 'gave-up'
                    ? {
                        attempts: [
                          { key: `review-${job.id}-a1`, status: 'ended' },
                          { key: `review-${job.id}-a2`, status: job.fate.state },
                        ],
                        gaveUp: true,
                      }
                    : { attempts: [{ key: `review-${job.id}-a1`, status: 'queued' }], gaveUp: false },
              }
            : {}),
        },
      }
    },
    async cancel(input: Parameters<RecallReview['cancel']>[0]) {
      cancels.push(input.jobId)
      const job = jobs.get(input.jobId)
      if (job) job.cancelled = true
      return { status: 'failed', jobId: input.jobId }
    },
  } as unknown as RecallReview
  return { review, requests, cancels }
}

/** The judge port: `match` for finding `hit` of a bug case, `not-a-bug` for the rest. */
function fakeJudge(options: { hit?: string; fail?: Error } = {}) {
  const calls: JudgeInput[] = []
  const registry: RecallJudge = {
    async call(_id, input) {
      calls.push(input)
      if (options.fail) throw options.fail
      return {
        model: 'fake',
        findings: input.findings.map((f) => ({
          id: f.id,
          class: (f.id === options.hit ? 'match' : 'not-a-bug') as JudgeClass,
          reason: 'because',
        })),
      } satisfies JudgeOutput
    },
  }
  return { registry, calls }
}

/** The clone port: a fixed directory per case, so a second run sees the first run's job. */
function fakeClones() {
  const removed: string[] = []
  const clones: RecallClones = {
    async create(reference) {
      return reference.id.startsWith('broken')
        ? { ok: false, reason: 'checkout_failed: x' }
        : { ok: true, dir: `/clone/${reference.id}` }
    },
    remove: (dir) => void removed.push(dir),
    diff: async () => 'diff --git a/src/a.ts b/src/a.ts',
  }
  return { clones, removed }
}

let root: string
let env: Record<string, string | undefined>
let t: TestHost | undefined

const writeCases = (rows: GtCase[]) => {
  mkdirSync(join(env.AGW_EVAL_DIR as string, 'review-gt'), { recursive: true })
  writeFileSync(gtPath('cases.jsonl', env), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

async function start(
  parts: { review: RecallReview; judge: ReturnType<typeof fakeJudge>; clones: ReturnType<typeof fakeClones> },
  input: Record<string, unknown>,
): Promise<Body> {
  t ??= await startTestHost({
    prefix: 'evalrecall',
    extra: [
      ...createEvalRecall({
        review: parts.review,
        registry: parts.judge.registry,
        clones: parts.clones.clones,
        env,
        pollMs: 1,
      }),
    ],
  })
  const { body } = await t.json(
    await t.call('/workflows/eval/recall', { method: 'POST', body: input, headers: { prefer: 'wait=60' } }),
  )
  return body
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agw-evalrecall-'))
})
afterAll(async () => {
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  env = { AGW_EVAL_DIR: join(root, `eval-${Math.random().toString(36).slice(2)}`) }
})
afterEach(async () => {
  await t?.close()
  t = undefined
})

const runWith = async (rows: GtCase[], fates: Record<string, Fate>, input: Record<string, unknown>, hit?: string) => {
  writeCases(rows)
  const review = fakeReview(fates)
  const judge = fakeJudge({ hit })
  const clones = fakeClones()
  const body = await start({ review: review.review, judge, clones }, input)
  return { body, review, judge, clones }
}

describe('agw eval recall', () => {
  test('a bug case is requested, waited for, judged and scored; a control counts its important findings', async () => {
    const { body, review, judge, clones } = await runWith(
      [bugCase('b1'), controlCase('c1')],
      {
        'feat: b1': { kind: 'submit', findings: [finding('f1', 'important'), finding('f2', 'nit')] },
        'chore: c1': { kind: 'submit', findings: [finding('f1', 'important', 'src/z.ts')] },
      },
      {},
      'f1',
    )
    expect(body.status).toBe('done')
    const out = body.output as Body
    expect(out.limit).toBe(GT_LIMIT)
    expect(out.judges).toMatchObject({ mode: 'dual', reason: 'no judge-calibration.json' })
    const [b1, c1] = out.cases as [Body, Body]
    expect(b1).toMatchObject({
      id: 'b1',
      status: 'scored',
      tier: 'light',
      seat: 'sonnet/low',
      account: 'max-b',
      wallMs: 420_000,
      pass: true,
    })
    expect(b1.scores).toMatchObject({ recall: 1, detected: 1, severityCalibration: 1, findings: 2, important: 1 })
    expect(b1.findings).toEqual([
      { id: 'f1', tag: 'important', file: 'src/a.ts', line: 2, class: 'match' },
      { id: 'f2', tag: 'nit', file: 'src/a.ts', line: 2, class: 'not-a-bug' },
    ])
    expect(c1).toMatchObject({ id: 'c1', status: 'scored', pass: false })
    expect(c1.scores).toMatchObject({ falseAlarms: 1, clean: 0 })
    const summary = out.summary as Body
    expect(summary.bug.recall).toMatchObject({ n: 1, hits: 1, p: 1 })
    expect(summary.control).toMatchObject({ n: 1, falseAlarms: 1, falseAlarmsPerControl: 1 })
    expect(review.requests).toHaveLength(2)
    expect(clones.removed.sort()).toEqual(['/clone/b1', '/clone/c1'])
    // dual mode: both seats asked per case with findings
    expect(judge.calls.map((c) => c.seat ?? 'a')).toEqual(['a', 'b', 'a', 'b'])
  })

  test('a calibration that clears the bar for both current judges scores with judge a alone', async () => {
    mkdirSync(join(env.AGW_EVAL_DIR as string, 'review-gt'), { recursive: true })
    writeFileSync(
      gtPath('judge-calibration.json', env),
      JSON.stringify({
        at: '2026-11-03T10:00:00.000Z',
        limit: GT_LIMIT,
        judgeVersions: { a: JUDGE_VERSION, b: JUDGE_B_VERSION },
        judgeModels: { a: ['m'], b: ['m'] },
        evalRuns: ['e1'],
        n: 100,
        agreement: 0.97,
        kappa: 0.93,
        ci95: { lo: 0.85, hi: 0.99 },
        bar: 0.8,
        met: true,
        confusion: { yy: 48, yn: 1, ny: 2, nn: 49 },
        classes: { n: 10, agreement: 0.9, confusion: {} },
      }),
    )
    const { body, judge } = await runWith(
      [bugCase('b1')],
      { 'feat: b1': { kind: 'submit', findings: [finding('f1', 'important')] } },
      {},
      'f1',
    )
    expect((body.output as Body).judges).toMatchObject({ mode: 'single', kappa: 0.93 })
    expect(judge.calls.map((c) => c.seat ?? 'a')).toEqual(['a'])
    expect(judge.calls[0]?.bug?.description).toBe(DESCRIPTION) // the judge sees the bug; the reviewer never does
  })

  test('the request carries the range, the subject as context, min light and a per-run thread, never the bug description', async () => {
    const { body, review } = await runWith([bugCase('b1')], {}, {})
    const [request] = review.requests
    expect(request).toEqual({
      cwd: '/clone/b1',
      scope: `${SHA(1)}..${SHA(2)}`,
      context: 'feat: b1',
      min: 'light',
      thread: `eval:${(body.output as Body).runId}:b1`,
    })
    expect(JSON.stringify(review.requests)).not.toContain('SECRET-BUG-DESCRIPTION')
    expect(JSON.stringify(review.requests)).not.toContain(SHA(3)) // nor the fix commit
  })

  test('a needs-human request, an abandoned job and a failed clone are unscored with their reason, not misses', async () => {
    const { body, clones } = await runWith(
      [bugCase('b1'), bugCase('b2'), bugCase('broken1'), bugCase('b4')],
      {
        'feat: b1': { kind: 'needs-human' },
        'feat: b2': { kind: 'abandon' },
        'feat: b4': { kind: 'submit', findings: [] },
      },
      {},
    )
    const out = body.output as Body
    expect((out.cases as Body[]).map((c) => `${c.id}:${c.status}:${c.reason}`)).toEqual([
      'b1:unscored:needs-human: round 4',
      'b2:unscored:abandoned',
      'broken1:unscored:clone: checkout_failed: x',
      'b4:scored:null',
    ])
    expect(out.summary).toMatchObject({
      scored: 1,
      unscored: 3,
      bug: { recall: { n: 1, hits: 0 } }, // only the submitted case is in the denominator
    })
    expect(clones.removed.sort()).toEqual(['/clone/b1', '/clone/b2', '/clone/b4'])
  })

  test('a job the factory gave up on is cancelled and unscored with the factory state; a merely held one keeps polling', async () => {
    const { body, review } = await runWith(
      [bugCase('b1'), bugCase('b2')],
      { 'feat: b1': { kind: 'gave-up', state: 'ended' }, 'feat: b2': { kind: 'waiting' } },
      {},
    )
    expect((body.output as Body).cases.map((c: Body) => `${c.id}:${c.status}:${c.reason}`)).toEqual([
      'b1:unscored:review gave up: ended',
      'b2:scored:null',
    ])
    expect(review.cancels).toEqual(['rv_1']) // only the wedged job; the held one was never cancelled
  })

  test('a second run over the same clone adopts the live job and does not request again', async () => {
    writeCases([bugCase('b1')])
    const review = fakeReview({})
    const parts = { review: review.review, judge: fakeJudge(), clones: fakeClones() }
    await start(parts, {})
    expect(review.requests).toHaveLength(1)
    await start(parts, { cases: 'b1' })
    expect(review.requests).toHaveLength(1)
  })

  test('a judge outage fails the case run, which the parent reports as unscored', async () => {
    writeCases([bugCase('b1')])
    const review = fakeReview({ 'feat: b1': { kind: 'submit', findings: [finding('f1', 'important')] } })
    const judge = fakeJudge({ fail: Object.assign(new Error('gateway down'), { code: 'UPSTREAM_ERROR' }) })
    const body = await start({ review: review.review, judge, clones: fakeClones() }, {})
    expect((body.output as Body).cases[0]).toMatchObject({
      status: 'unscored',
      reason: 'case run failed (see its run record)',
    })
  })

  test('an unusable judge answer leaves that case unscored with the reason', async () => {
    writeCases([bugCase('b1')])
    const review = fakeReview({ 'feat: b1': { kind: 'submit', findings: [finding('f1', 'important')] } })
    const judge = fakeJudge({ fail: Object.assign(new Error('not JSON'), { code: 'INVALID_OUTPUT' }) })
    const body = await start({ review: review.review, judge, clones: fakeClones() }, {})
    expect((body.output as Body).cases[0]).toMatchObject({
      status: 'unscored',
      reason: 'judge: INVALID_OUTPUT: not JSON',
    })
  })

  test('filters: split, kind, ids and limit; an unknown id is an error', () => {
    const rows = [bugCase('b1', 'dev'), controlCase('c1', 'dev'), bugCase('b2', 'test'), bugCase('b3', 'test')]
    const pick = (input: Record<string, unknown>) => selectCases(rows, evalRecallInput.parse(input)).map((c) => c.id)
    expect(pick({ split: 'test' })).toEqual(['b2', 'b3'])
    expect(pick({ kind: 'control' })).toEqual(['c1'])
    expect(pick({ kind: 'bug', limit: 2 })).toEqual(['b1', 'b2'])
    expect(pick({ cases: 'b3,b1' })).toEqual(['b3', 'b1'])
    expect(() => pick({ cases: 'nope' })).toThrow('unknown case ids: nope')
  })
})

describe('summarize', () => {
  const scored = (kind: 'bug' | 'control', scores: Record<string, number>) => ({
    id: 'x',
    split: 'test' as const,
    kind,
    status: 'scored' as const,
    reason: null,
    tier: 'light',
    seat: null,
    account: null,
    wallMs: 1000,
    findings: [],
    scores,
    pass: null,
  })
  test('recall with a Wilson interval, false alarms per control, pooled noise; unscored is no denominator', () => {
    const summary = summarize([
      scored('bug', { recall: 1, detected: 1, severityCalibration: 1, findings: 2, noise: 0.5 }),
      scored('bug', { recall: 0, detected: 0, findings: 0 }),
      scored('control', { falseAlarms: 2, clean: 0, findings: 2, noise: 0 }),
      scored('control', { falseAlarms: 0, clean: 1, findings: 0 }),
      { ...scored('bug', {}), status: 'unscored', scores: null, reason: 'abandoned', wallMs: null },
    ])
    expect(summary.bug.recall).toMatchObject({ n: 2, hits: 1, p: 0.5 })
    expect(summary.bug.recall.lo).toBeCloseTo(0.095, 2)
    expect(summary.control).toMatchObject({ n: 2, falseAlarms: 2, falseAlarmsPerControl: 1 })
    expect(summary.noise).toBeCloseTo(1 / 4)
    expect(summary).toMatchObject({ scored: 4, unscored: 1, unscoredReasons: { abandoned: 1 } })
  })
})
