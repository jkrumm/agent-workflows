import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityCallError,
  createCapabilities,
  createRegistry,
  JUDGE_B_VERSION,
  JUDGE_VERSION,
} from '@agent-workflows/capabilities'
import {
  GT_LIMIT,
  type GtBugCase,
  JudgeBRecord,
  gtPath,
  JudgeCalibration,
  type JudgeClass,
  type JudgeInput,
  type JudgeOutput,
} from '@agent-workflows/eval'
import {
  CalibrateInputError,
  type JudgeCaller,
  planCalibration,
  runCalibration,
} from '../src/workflows/eval-gt/calibrate.ts'
import { hostModules } from '../src/workflows/index.ts'
import { createCapabilityWorkflows } from '../src/capability-runs.ts'
import { fakeTransports } from '../../capabilities/src/testing/index.ts'
import { LEGACY_JUDGE_RUN_VERSIONS, judgeRunVersions } from '../src/workflows/eval-gt/versions.ts'
import { pgJudgeRuns } from '../src/workflows/eval-gt/judge-runs.ts'
import { createEvalGtWorkflows } from '../src/workflows/eval-gt/index.ts'
import type { JudgeRun, JudgeRunReader } from '../src/workflows/eval-gt/judge-runs.ts'
import { type Body, startTestHost, type TestHost } from './support.ts'

const ZEROS = '0'.repeat(40)
let root: string
let env: Record<string, string | undefined>
let t: TestHost

const bugCase = (id: string): GtBugCase => ({
  id,
  kind: 'bug',
  split: 'test',
  repo: 'SourceRoot/demo',
  sha: ZEROS,
  parent: ZEROS,
  subject: 'feat: demo',
  minerVersion: 'm1',
  candidateId: id,
  bug: {
    location: { file: 'src/a.ts', startLine: 2, endLine: 3 },
    description: 'The loop runs once too often.',
    bugClass: 'logic',
    severity: 'major',
    fixSha: ZEROS,
    fixSubject: 'fix: bound',
  },
})

function writeCases(rows: unknown[]) {
  mkdirSync(join(env.AGW_EVAL_DIR as string, 'review-gt'), { recursive: true })
  writeFileSync(gtPath('cases.jsonl', env), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

/** A judge-a run on case `caseId`: finding `i` is class `classes[i]`; the preselected ones are the first `pre` ids. */
const CURRENT = 'cap-hash-current'
const LEGACY = 'cap-hash-legacy'
const RUN_VERSIONS = [CURRENT, LEGACY]

function aRun(
  runId: string,
  caseId: string,
  classes: JudgeClass[],
  pre = classes.length,
  version: string | null = CURRENT,
): JudgeRun {
  const findings = classes.map((_, i) => ({
    id: String(i),
    tag: 'important' as const,
    file: 'src/a.ts',
    line: 2,
    message: `finding ${i}`,
  }))
  const input: JudgeInput = {
    caseId,
    bug: { location: { file: 'src/a.ts', startLine: 2, endLine: 3 }, description: 'The loop runs once too often.' },
    findings,
    preselected: findings.slice(0, pre).map((f) => f.id),
    diff: 'diff --git a/src/a.ts b/src/a.ts\n',
  }
  const output: JudgeOutput = {
    findings: classes.map((c, i) => ({ id: String(i), class: c, reason: `a${i}` })),
    model: 'model-a',
  }
  return { runId, evalRunId: 'eval-1', input, output, version }
}

/** The error a promise rejects with (a missing rejection fails the test). */
const failure = async (promise: Promise<unknown>): Promise<Error> => {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error as Error,
  )
  if (outcome === null) throw new Error('expected a rejection')
  return outcome
}

const reader = (runs: JudgeRun[]): JudgeRunReader => ({
  async judgeRuns(ids) {
    return runs.filter((r) => ids.includes(r.evalRunId))
  },
})

/** Judge `b`: answers per run id from `byRun` (default: what `a` said), records every call. */
function judgeB(byRun: Record<string, JudgeClass[]> = {}, fail?: (input: JudgeInput) => unknown) {
  const calls: JudgeInput[] = []
  const registry: JudgeCaller = {
    async call(_id, input) {
      calls.push(input)
      const thrown = fail?.(input)
      if (thrown) throw thrown
      const classes = byRun[input.caseId] ?? []
      return {
        findings: input.findings.map((f, i) => ({ id: f.id, class: classes[i] ?? 'unclear', reason: `b${f.id}` })),
        model: 'model-b',
      }
    },
  }
  return { registry, calls }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agw-evalgt-'))
  env = { AGW_EVAL_DIR: join(root, 'eval') }
  t = await startTestHost({
    prefix: 'evalgt',
    extra: createEvalGtWorkflows({
      registry: judgeB().registry,
      env,
      judgeRuns: reader([]),
      judgeRunVersions: RUN_VERSIONS,
    }),
  })
})
afterAll(async () => {
  await t.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  env.AGW_EVAL_DIR = join(root, `eval-${Math.random().toString(36).slice(2)}`)
})
afterEach(() => {
  rmSync(env.AGW_EVAL_DIR as string, { recursive: true, force: true })
})

describe('planCalibration', () => {
  test('pairs are judge-positive matches and preselected non-matches; the rest of a run is not a pair', async () => {
    writeCases([bugCase('c1')])
    // 0 match (positive), 1 real preselected (negative), 2 nit not preselected (no pair)
    const plan = await planCalibration(
      {
        env,
        judgeRuns: reader([aRun('r1', 'c1', ['match', 'real', 'nit'], 2)]),
        judge: judgeB().registry,
        judgeRunVersions: RUN_VERSIONS,
      },
      { evalRuns: ['eval-1'], pairs: 100, seed: 1 },
    )
    expect(plan).toMatchObject({ positives: 1, negatives: 1 })
    expect(plan.pairs.map((p) => `${p.findingId}:${p.aMatch}`).sort()).toEqual(['0:true', '1:false'])
    expect([...plan.runs.keys()]).toEqual(['r1'])
    expect(plan.notes.join(' ')).toContain('judge-positive pairs exist for a quota of 50')
  })

  test('half the budget on each side, seeded, one judge-b call per run holding a sampled pair', async () => {
    writeCases([bugCase('c1')])
    const runs = Array.from({ length: 10 }, (_, i) => aRun(`r${i}`, 'c1', ['match', 'real']))
    const deps = { env, judgeRuns: reader(runs), judge: judgeB().registry, judgeRunVersions: RUN_VERSIONS }
    const plan = await planCalibration(deps, { evalRuns: ['eval-1'], pairs: 6, seed: 3 })
    expect(plan).toMatchObject({ positives: 3, negatives: 3 })
    expect(plan.runs.size).toBeLessThanOrEqual(6)
    const again = await planCalibration(deps, { evalRuns: ['eval-1'], pairs: 6, seed: 3 })
    expect(again.pairs).toEqual(plan.pairs)
  })

  test('judge runs of an unknown case, a control or an unusable shape are skipped, with a note', async () => {
    writeCases([bugCase('c1')])
    const control = aRun('rc', 'c1', ['nit'])
    ;(control.input as JudgeInput).bug = null
    const runs = [
      aRun('r1', 'c1', ['match']),
      aRun('r2', 'other', ['match']),
      control,
      { ...aRun('r4', 'c1', []), input: 1 },
    ]
    const plan = await planCalibration(
      { env, judgeRuns: reader(runs), judge: judgeB().registry, judgeRunVersions: RUN_VERSIONS },
      { evalRuns: ['eval-1'], pairs: 10, seed: 1 },
    )
    expect([...plan.runs.keys()]).toEqual(['r1'])
    expect(plan.notes.join(' ')).toContain('2 judge runs skipped: no known bug')
    expect(plan.notes.join(' ')).toContain('1 judge runs skipped: their case is not in cases.jsonl')
  })

  test('only judge-a runs count: a seat-b run (the scorer’s dual mode) is skipped and counted', async () => {
    writeCases([bugCase('c1')])
    const seatB = aRun('rb', 'c1', ['match', 'real'])
    ;(seatB.input as JudgeInput).seat = 'b'
    const seatA = aRun('ra', 'c1', ['match', 'real'])
    ;(seatA.input as JudgeInput).seat = 'a'
    const plan = await planCalibration(
      {
        env,
        judgeRuns: reader([seatB, seatA, aRun('rn', 'c1', ['match'])]),
        judge: judgeB().registry,
        judgeRunVersions: RUN_VERSIONS,
      },
      { evalRuns: ['eval-1'], pairs: 100, seed: 1 },
    )
    expect([...plan.runs.keys()].sort()).toEqual(['ra', 'rn'])
    expect(plan.skipped).toEqual({ unusable: 0, unknownCase: 0, otherSeat: 1, otherVersion: 0 })
  })

  test('only runs of the current capability version (or a known legacy one) count; others are skipped and counted', async () => {
    writeCases([bugCase('c1')])
    const runs = [
      aRun('cur', 'c1', ['match']),
      aRun('old', 'c1', ['match'], 1, LEGACY),
      aRun('new', 'c1', ['match'], 1, 'cap-hash-unknown'),
      aRun('none', 'c1', ['match'], 1, null),
    ]
    const plan = await planCalibration(
      { env, judgeRuns: reader(runs), judge: judgeB().registry, judgeRunVersions: RUN_VERSIONS },
      { evalRuns: ['eval-1'], pairs: 100, seed: 1 },
    )
    expect([...plan.runs.keys()].sort()).toEqual(['cur', 'old'])
    expect(plan.skipped.otherVersion).toBe(2)
    expect(plan.notes.join(' ')).toContain('2 judge runs skipped: made by another version')
  })

  test('no mined case, or no pair, is the caller’s input to fix', async () => {
    const deps = (runs: JudgeRun[]) => ({
      env,
      judgeRuns: reader(runs),
      judge: judgeB().registry,
      judgeRunVersions: RUN_VERSIONS,
    })
    const request = { evalRuns: ['eval-1'], pairs: 10, seed: 1 }
    expect(await failure(planCalibration(deps([]), request))).toBeInstanceOf(CalibrateInputError)
    writeCases([bugCase('c1')])
    expect((await failure(planCalibration(deps([]), request))).message).toContain('no judge pair')
  })
})

describe('runCalibration', () => {
  const options = (evalRuns = ['eval-1']) => ({
    callContext: {} as never,
    signal: new AbortController().signal,
    progress: () => {},
    now: () => new Date('2026-11-03T10:00:00Z'),
    concurrency: 2,
    evalRuns,
  })

  async function plan(runs: JudgeRun[], pairs = 100) {
    writeCases([bugCase('c1'), bugCase('c2')])
    return planCalibration(
      { env, judgeRuns: reader(runs), judge: judgeB().registry, judgeRunVersions: RUN_VERSIONS },
      { evalRuns: ['eval-1'], pairs, seed: 1 },
    )
  }

  test('re-asks seat b on exactly the judge-a input and compares per pair: κ, CI, agreement, confusion', async () => {
    // 20 runs of case c1: findings [match, real]; b agrees on all matches and on 18 of the 20 non-matches
    const runs = Array.from({ length: 20 }, (_, i) => aRun(`r${i}`, 'c1', ['match', 'real']))
    const p = await plan(runs)
    let seen = 0
    const { registry, calls } = judgeB({}, () => undefined)
    registry.call = async (_id, input) => {
      calls.push(input)
      const flip = seen++ < 2
      return {
        findings: [
          { id: '0', class: 'match', reason: 'b0' },
          { id: '1', class: flip ? 'match' : 'not-a-bug', reason: 'b1' },
        ],
        model: 'model-b',
      }
    }
    const out = await runCalibration(
      { env, judgeRuns: reader(runs), judge: registry, judgeRunVersions: RUN_VERSIONS },
      p,
      options(),
    )
    expect(calls).toHaveLength(20)
    for (const call of calls) {
      const recorded = runs.find((r) => (r.input as JudgeInput).caseId === call.caseId)?.input as JudgeInput
      expect({ ...call, seat: undefined }).toEqual({ ...recorded, seat: undefined })
      expect(call.seat).toBe('b')
    }
    const c = out.calibration
    expect(c.confusion).toEqual({ yy: 20, yn: 0, ny: 2, nn: 18 })
    expect(c).toMatchObject({
      n: 40,
      limit: GT_LIMIT,
      judgeVersions: { a: JUDGE_VERSION, b: JUDGE_B_VERSION },
      bar: 0.8,
    })
    expect(c.agreement).toBeCloseTo(0.95, 10)
    expect(c.kappa).toBeCloseTo(0.9, 10)
    expect(c.ci95?.lo).toBeLessThan(0.9)
    expect(c.ci95?.hi).toBeGreaterThan(0.9)
    expect(c.met).toBe(true)
    expect(c.judgeModels).toEqual({ a: ['model-a'], b: ['model-b'] })
    expect(JudgeCalibration.safeParse(c).success).toBe(true)
  })

  test('agreement on the findings neither judge matched, by class', async () => {
    const runs = [aRun('r1', 'c1', ['match', 'real', 'nit', 'not-a-bug', 'unclear'])]
    const p = await plan(runs)
    const { registry } = judgeB({ c1: ['match', 'real', 'not-a-bug', 'not-a-bug', 'unclear'] })
    const { calibration } = await runCalibration(
      { env, judgeRuns: reader(runs), judge: registry, judgeRunVersions: RUN_VERSIONS },
      p,
      options(),
    )
    expect(calibration.classes.n).toBe(4)
    expect(calibration.classes.agreement).toBe(0.75)
    expect(calibration.classes.confusion).toMatchObject({
      real: { real: 1 },
      nit: { 'not-a-bug': 1 },
      'not-a-bug': { 'not-a-bug': 1 },
      unclear: { unclear: 1 },
    })
  })

  test('below the bar: met is false; an undefined κ is null and not met', async () => {
    const runs = [aRun('r1', 'c1', ['match', 'real'])]
    const p = await plan(runs)
    const split = await runCalibration(
      {
        env,
        judgeRuns: reader(runs),
        judge: judgeB({ c1: ['real', 'match'] }).registry,
        judgeRunVersions: RUN_VERSIONS,
      },
      p,
      options(),
    )
    expect(split.calibration).toMatchObject({ kappa: -1, met: false, confusion: { yy: 0, yn: 1, ny: 1, nn: 0 } })
    const allMatch = [aRun('r2', 'c1', ['match'])]
    const q = await plan(allMatch)
    const same = await runCalibration(
      { env, judgeRuns: reader(allMatch), judge: judgeB({ c1: ['match'] }).registry, judgeRunVersions: RUN_VERSIONS },
      q,
      options(),
    )
    expect(same.calibration).toMatchObject({ kappa: null, ci95: null, met: false, agreement: 1 })
  })

  test('every judge-b answer is appended as it arrives; a stop keeps what was paid and a rerun asks only the missing', async () => {
    const runs = Array.from({ length: 6 }, (_, i) => aRun(`r${i}`, 'c1', ['match', 'real']))
    const p = await plan(runs)
    let served = 0
    const broken = judgeB({ c1: ['match', 'real'] }, () =>
      ++served > 3
        ? new CapabilityCallError('UPSTREAM_ERROR', 502, 'no eval credit', true, { status: 403 })
        : undefined,
    )
    const deps = (judge: JudgeCaller) => ({ env, judgeRuns: reader(runs), judge, judgeRunVersions: RUN_VERSIONS })
    const stopped = await failure(runCalibration(deps(broken.registry), p, { ...options(), concurrency: 1 }))
    expect(stopped.message).toContain('no eval credit')
    const kept = readFileSync(gtPath('judge-b.jsonl', env), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JudgeBRecord.parse(JSON.parse(l)))
    expect(kept).toHaveLength(3)
    expect(kept.every((r) => r.judgeBVersion === JUDGE_B_VERSION)).toBe(true)
    expect(statSync(gtPath('judge-b.jsonl', env)).mode & 0o777).toBe(0o600)

    // The plan sees them as done; the rerun asks the other three only, and compares all six.
    const again = await planCalibration(deps(judgeB().registry), { evalRuns: ['eval-1'], pairs: 100, seed: 1 })
    expect(again.cached.size).toBe(3)
    const fresh = judgeB({ c1: ['match', 'real'] })
    const done = await runCalibration(deps(fresh.registry), again, options())
    expect(fresh.calls).toHaveLength(3)
    expect(new Set(fresh.calls.map((c) => c.findings.length)).size).toBe(1)
    expect(done).toMatchObject({ asked: 3, reused: 3 })
    expect(done.calibration.n).toBe(12)
    expect(done.calibration.judgeVersions).toEqual({ a: JUDGE_VERSION, b: JUDGE_B_VERSION })

    // Nothing left: a third pass makes no call.
    const none = judgeB()
    await runCalibration(
      deps(none.registry),
      await planCalibration(deps(none.registry), { evalRuns: ['eval-1'], pairs: 100, seed: 1 }),
      options(),
    )
    expect(none.calls).toHaveLength(0)
  })

  test('an answer recorded under another judge-b version is not reused', async () => {
    const runs = [aRun('r1', 'c1', ['match', 'real'])]
    const p = await plan(runs)
    mkdirSync(join(env.AGW_EVAL_DIR as string, 'review-gt'), { recursive: true })
    const record = {
      runId: 'r1',
      judgeBVersion: 'eval-judge-b-old',
      at: '2026-11-03T10:00:00.000Z',
      output: { findings: [], model: 'm' },
    }
    writeFileSync(gtPath('judge-b.jsonl', env), `${JSON.stringify(record)}\n`)
    const b = judgeB({ c1: ['match', 'real'] })
    const out = await runCalibration(
      { env, judgeRuns: reader(runs), judge: b.registry, judgeRunVersions: RUN_VERSIONS },
      p,
      options(),
    )
    expect(b.calls).toHaveLength(1)
    expect(out).toMatchObject({ asked: 1, reused: 0 })
  })

  test('judge b failing with an answer skips that run; any other failure stops the calibration', async () => {
    const runs = [aRun('r1', 'c1', ['match', 'real']), aRun('r2', 'c2', ['match', 'real'])]
    const p = await plan(runs)
    const refuse = judgeB({ c2: ['match', 'real'] }, (input) =>
      input.caseId === 'c1' ? new CapabilityCallError('INVALID_OUTPUT', 502, 'Model output rejected', true) : undefined,
    )
    const out = await runCalibration(
      { env, judgeRuns: reader(runs), judge: refuse.registry, judgeRunVersions: RUN_VERSIONS },
      p,
      options(),
    )
    expect(out.skippedRuns).toBe(1)
    expect(out.calibration.n).toBe(2)
    expect(out.notes.join(' ')).toContain('1 judge runs skipped')

    const noCredit = judgeB(
      {},
      () => new CapabilityCallError('UPSTREAM_ERROR', 502, 'no eval credit', true, { status: 403 }),
    )
    const stopped = await failure(
      runCalibration(
        { env, judgeRuns: reader(runs), judge: noCredit.registry, judgeRunVersions: RUN_VERSIONS },
        p,
        options(),
      ),
    )
    expect(stopped.message).toContain('no eval credit')
  })
})

describe('judge run versions', () => {
  test('the current capability hash and the legacy ones count; the legacy hash is the one from before judge b', () => {
    const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
    const current = createCapabilityWorkflows(registry).get('eval.judge')?.version
    expect(current).toMatch(/^[0-9a-f]{12}$/)
    expect(judgeRunVersions(registry)).toEqual([current as string, ...LEGACY_JUDGE_RUN_VERSIONS])
    expect(LEGACY_JUDGE_RUN_VERSIONS).toEqual(['8e1f56d6a647'])
  })

  test('the journal query returns the version the run started under', async () => {
    const rows = [{ id: 'r1', eval_run: 'e1', input: {}, output: {}, version: 'abc' }]
    const queries: string[] = []
    const pool = {
      query: async (text: string) => {
        queries.push(text)
        return { rows }
      },
    }
    const runs = await pgJudgeRuns(pool as never, 'agw').judgeRuns(['e1'])
    expect(runs).toEqual([{ runId: 'r1', evalRunId: 'e1', input: {}, output: {}, version: 'abc' }])
    expect(queries[0]).toContain('version_started')
  })
})

describe('agw eval gt calibrate', () => {
  async function start(input: Record<string, unknown>) {
    const { body } = await t.json(
      await t.call('/workflows/eval/gt/calibrate', { method: 'POST', body: input, headers: { prefer: 'wait=60' } }),
    )
    return body
  }

  test('is the one gt command, with its flags; the owner pack and ingest are gone', async () => {
    const { buildCommands } = await import('../../cli/src/spec.ts')
    const { commands, skipped } = buildCommands(await t.host.openapi())
    expect(skipped).toEqual([])
    expect(commands.filter((c) => c.words[0] === 'eval' && c.words[1] === 'gt').map((c) => c.words.join(' '))).toEqual([
      'eval gt calibrate',
    ])
    const command = commands.find((c) => c.words.join(' ') === 'eval gt calibrate')
    expect(command?.x).toMatchObject({ kind: 'workflow', mutating: true })
    expect(command?.fields.map((f) => f.flag).sort()).toEqual(['eval-runs', 'pairs', 'seed', 'yes'])
  })

  test('without --yes: the plan and an estimate, no call and no file', async () => {
    writeCases([bugCase('c1')])
    const runs = [aRun('r1', 'c1', ['match', 'real'])]
    const { registry, calls } = judgeB({ c1: ['match', 'real'] })
    const host = await startTestHost({
      prefix: 'evalgtplan',
      extra: createEvalGtWorkflows({ registry, env, judgeRuns: reader(runs), judgeRunVersions: RUN_VERSIONS }),
    })
    try {
      const { body } = await host.json(
        await host.call('/workflows/eval/gt/calibrate', {
          method: 'POST',
          body: { evalRuns: ['eval-1'] },
          headers: { prefer: 'wait=60' },
        }),
      )
      expect(body.status).toBe('done')
      const out = body.output as Body
      expect(out).toMatchObject({
        limit: GT_LIMIT,
        spent: false,
        calibration: null,
        written: null,
        plan: { pairs: 2, judgePositive: 1, judgeNegative: 1, judgeBCalls: 1 },
      })
      expect(out.plan.estimateUsd).toBeGreaterThan(0)
      expect(calls).toHaveLength(0)
      expect(existsSync(gtPath('judge-calibration.json', env))).toBe(false)
    } finally {
      await host.close()
    }
  })

  test('--yes calls judge b, writes judge-calibration.json (aggregates, mode 0600) and says what the scorer does', async () => {
    writeCases([bugCase('c1')])
    const runs = Array.from({ length: 10 }, (_, i) => aRun(`r${i}`, 'c1', ['match', 'real']))
    const { registry, calls } = judgeB({ c1: ['match', 'not-a-bug'] })
    const host = await startTestHost({
      prefix: 'evalgtyes',
      extra: createEvalGtWorkflows({
        registry,
        env,
        judgeRuns: reader(runs),
        judgeRunVersions: RUN_VERSIONS,
        now: () => new Date('2026-11-03T10:00:00Z'),
      }),
    })
    try {
      const { body } = await host.json(
        await host.call('/workflows/eval/gt/calibrate', {
          method: 'POST',
          body: { evalRuns: ['eval-1'], yes: true, pairs: 20 },
          headers: { prefer: 'wait=60' },
        }),
      )
      expect(body.status).toBe('done')
      const out = body.output as Body
      expect(out).toMatchObject({
        spent: true,
        limit: GT_LIMIT,
        calibration: { kappa: 1, met: true, n: 20, judgeVersions: { a: JUDGE_VERSION, b: JUDGE_B_VERSION } },
        judgeB: { asked: 10, reused: 0, skippedAnswers: 0 },
      })
      expect(out.scorer).toContain('one judge (a)')
      expect(calls).toHaveLength(10)
      const path = gtPath('judge-calibration.json', env)
      expect(out.written).toBe(path)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      const file = JudgeCalibration.parse(JSON.parse(readFileSync(path, 'utf8')))
      expect(file).toMatchObject({
        at: '2026-11-03T10:00:00.000Z',
        evalRuns: ['eval-1'],
        judgeVersions: { a: JUDGE_VERSION, b: JUDGE_B_VERSION },
        limit: GT_LIMIT,
      })
      // aggregates only: no finding text, case id or run id
      expect(readFileSync(path, 'utf8')).not.toMatch(/finding \d|"c1"|"r\d"/)
    } finally {
      await host.close()
    }
  })

  test('the host serves it as a discovered module', async () => {
    expect((await hostModules()).map((m) => m.id)).toContain('eval-gt')
  })

  test('no mined case is an invalid input', async () => {
    const body = await start({ evalRuns: ['eval-1'] })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body)).toContain('no mined bug case')
  })
})
