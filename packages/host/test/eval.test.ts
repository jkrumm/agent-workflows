import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, casesPath, writeCases } from '@agent-workflows/eval'
import type { FinalScore, Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createCheckWorkflows } from '../src/workflows/check/index.ts'
import { DriftJob, driftOptionsFromEnv, wireEval, createEvalWorkflows } from '../src/workflows/eval/index.ts'
import { HOST_MODULES, suitesOf } from '../src/workflows/index.ts'
import { testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

const db = freshSchema('evalwf')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evaltest-'))
const home = join(root, 'home')
const evalDir = join(root, 'eval')
const tmpRoot = join(root, 'tmp')
const env = { AGW_EVAL_DIR: evalDir, AGW_EVAL_HOME: home, AGW_DRIFT_RATE: '0' }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed`)
  return out.trim()
}

const checkCase = (id: string, baseSha: string, passed: boolean) => ({
  id,
  source: 'synthetic',
  createdAt: '2026-10-20T10:00:00.000Z',
  repo: 'SourceRoot/demo',
  input: { commands: ['bun test'] },
  baseSha,
  baseInferred: false,
  patch: 'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+two\n',
  legacy: {
    passed,
    steps: [{ name: 'test', passed }],
    costUsd: null,
    costExact: true,
    wallMs: null,
  },
})

let rt: Runtime
let platform: ReturnType<typeof testPlatform>
let wiring: ReturnType<typeof wireEval>
const host = new FakeAgentHost(async () => ({
  output: { passed: true, steps: [{ name: 'test', passed: true }], summary: 'All 1 steps passed' },
  usage: { model: 'm', tokens: { input: 100, output: 10, cacheRead: 0, reasoning: 0 }, cost: 0.02, toolCalls: 3 },
}))
const check = createCheckWorkflows()
const evals = createEvalWorkflows(suitesOf(HOST_MODULES), { env, tmpRoot })
const [evalRun, evalCompare] = evals.map((e) => e.workflow) as [
  (typeof evals)[0]['workflow'],
  (typeof evals)[1]['workflow'],
]

beforeAll(async () => {
  const repo = join(home, 'SourceRoot', 'demo')
  mkdirSync(repo, { recursive: true })
  mkdirSync(tmpRoot)
  await git(repo, 'init', '--quiet')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init')
  const sha = await git(repo, 'rev-parse', 'HEAD')
  writeCases(casesPath('check', env), CheckCase, [
    checkCase('case-green', sha, true),
    checkCase('case-red', sha, false),
  ])

  platform = testPlatform(db.schema)
  rt = testRuntime({
    schema: db.schema,
    workflows: [...check, ...evals].map((e) => e.workflow),
    host,
    middleware: platform.middleware,
  })
  wiring = wireEval({ runtime: rt, workflows: [...check, ...evals], env })
  await rt.open()
  wiring.start()
})

afterAll(async () => {
  await wiring.close()
  await rt.close()
  await platform.close()
  await sql.close()
  await db.drop()
  rmSync(root, { recursive: true, force: true })
})

// biome-ignore lint/suspicious/noExplicitAny: outputs are asserted field by field
type Out = Record<string, any>
async function evalOnce(input: Record<string, unknown>): Promise<{ output: Out; error: string | null }> {
  const { runId } = await rt.start(evalRun, input, { purpose: 'prod' })
  const end = await rt.wait(runId)
  return { output: end.output as Out, error: end.error?.message ?? null }
}

describe('agw eval run', () => {
  test('without --yes: the plan and an estimate, nothing runs', async () => {
    const { output } = await evalOnce({ workflow: 'check' })
    expect(output).toMatchObject({
      workflow: 'check',
      ran: false,
      plan: { ids: ['case-green', 'case-red'], estimate: { historyRuns: 0, meanCostUsd: null, totalUsd: null } },
      cases: [],
    })
    expect(host.count('open')).toBe(0)
  })

  test('two cases on a fake host: purpose eval, scored against the reference, fingerprint recorded', async () => {
    const { output, error } = await evalOnce({ workflow: 'check', yes: true, concurrency: 2 })
    expect(error).toBeNull()
    expect(output.ran).toBe(true)
    expect(output.fingerprints).toHaveLength(1)
    const [green, red] = output.cases
    expect(green).toMatchObject({ caseId: 'case-green', status: 'scored', runStatus: 'done', pass: true })
    expect(green.scores).toEqual({
      valid: 1,
      reported: 1,
      evidence: 1,
      consistent: 1,
      outcomeAgreement: 1,
      stepAgreement: 1,
    })
    expect(red).toMatchObject({ caseId: 'case-red', status: 'scored', pass: false })
    expect(red.scores).toMatchObject({ outcomeAgreement: 0, stepAgreement: 0 })
    expect(output.summary).toMatchObject({ scored: 2, skipped: 0, errors: 0, passRate: 0.5 })
    expect(output.summary.means.outcomeAgreement).toBe(0.5)

    const row = await sql.run(green.runId)
    expect(row).toMatchObject({
      workflow: 'check',
      purpose: 'eval',
      score_source: 'regression',
      fingerprint: output.fingerprints[0],
      scores: { final: { caseId: 'case-green', source: 'regression', args: {} } },
    })
    expect(readdirSync(tmpRoot)).toEqual([]) // clones removed

    const again = await evalOnce({ workflow: 'check', ids: 'case-red' })
    expect(again.output.plan.estimate).toMatchObject({ historyRuns: 2, meanCostUsd: 0.02 })
    expect(again.output.plan.estimate.totalUsd).toBeCloseTo(0.02, 10)
  })

  test('an unknown case id or args that do not fit the input fail before anything runs', async () => {
    const opened = host.count('open')
    expect((await evalOnce({ workflow: 'check', ids: 'case-red,ghost', yes: true })).error).toContain('ghost')
    expect((await evalOnce({ workflow: 'check', ids: 'case-red, case-red,case-green' })).output.plan.ids).toEqual([
      'case-red',
      'case-green',
    ])
    expect((await evalOnce({ workflow: 'check', args: { nope: 1 }, yes: true })).error).toContain('args do not fit')
    expect(host.count('open')).toBe(opened)
  })

  test('arms with equal fingerprints compare by their args', async () => {
    const b = await evalOnce({ workflow: 'check', yes: true, args: { stepTimeoutSeconds: 30 } })
    expect(b.output.summary.scored).toBe(2)
    const fp = b.output.fingerprints[0] as string
    const { runId } = await rt.start(
      evalCompare,
      { workflow: 'check', a: fp.slice(0, 12), b: fp, bArgs: { stepTimeoutSeconds: 30 } },
      { purpose: 'prod' },
    )
    const end = await rt.wait(runId)
    const out = end.output as Out
    expect(out.cases).toMatchObject({ paired: 2 })
    expect(out.a).toMatchObject({ fingerprint: fp, args: {} })
    expect(out.b).toMatchObject({ fingerprint: fp, args: { stepTimeoutSeconds: 30 } })
    expect(out.warnings).toContain('only 2 paired cases (fewer than 5): every verdict is withheld')
    const same = await rt.wait(
      (await rt.start(evalCompare, { workflow: 'check', a: fp, b: fp }, { purpose: 'prod' })).runId,
    )
    expect(same.error?.message).toContain('the same fingerprint and args')
  })
})

describe('agw eval compare on synthetic runs', () => {
  const insert = async (
    id: string,
    fp: string,
    caseId: string,
    recall: number,
    cost: number | null,
    extra: { unpriced?: number; scorer?: string; error?: string } = {},
  ) =>
    sql.pool.query(
      `insert into "${db.schema}".runs (id, workflow, root_id, purpose, input, input_hash, lock_key, version_started,
         status, fingerprint, cost, wall_ms, tokens_input, tokens_output, tool_calls, unpriced_calls, scores,
         score_source, scored_at, finished_at)
       values ($1, 'review', $1, 'eval', '{}', 'h', 1, 'v', 'done', $2, $3, 1000, 100, 10, 4, $5, $4, 'regression', now(), now())`,
      [
        id,
        fp,
        cost,
        JSON.stringify({
          final: extra.error
            ? { source: 'regression', scorer: extra.scorer ?? 'r1', caseId, scores: {}, pass: null, error: extra.error }
            : { source: 'regression', scorer: extra.scorer ?? 'r1', caseId, scores: { recall }, pass: recall > 0.6 },
        }),
        extra.unpriced ?? 0,
      ],
    )

  test('known deltas: B recalls more and costs half', async () => {
    for (let i = 0; i < 12; i++) {
      await insert(`syn-a-${i}`, 'fpaaaaaaaa-1', `c${i}`, 0.5, 1)
      await insert(`syn-b-${i}`, 'fpbbbbbbbb-2', `c${i}`, 0.7, 0.5)
    }
    const { runId } = await rt.start(
      evalCompare,
      { workflow: 'review', a: 'fpaaaaaaaa', b: 'fpbbbbbbbb' },
      { purpose: 'prod' },
    )
    const out = (await rt.wait(runId)).output as Out
    expect(out.cases.paired).toBe(12)
    expect(out.bBetter).toEqual(['pass', 'recall', 'costUsd'])
    expect(out.bWorse).toEqual([])
    const recall = out.metrics.find((m: Out) => m.metric === 'recall')
    expect(recall.meanDelta).toBeCloseTo(0.2, 10)
    expect(out.warnings).toEqual([])
    const ambiguous = await rt.wait(
      (await rt.start(evalCompare, { workflow: 'review', a: 'fpaaaaaaaa', b: 'fpbbbbbbbb-2x' }, { purpose: 'prod' }))
        .runId,
    )
    expect(ambiguous.error?.message).toContain('arm B: no regression runs')
  })

  test('cost gaps split by cause, scorer errors left out, mixed scorers warned, few pairs decide nothing', async () => {
    for (let i = 0; i < 6; i++) {
      await insert(`mix-a-${i}`, 'fpcccccccc-3', `m${i}`, 0.5, 1, i === 0 ? { scorer: 'r0' } : {})
      await insert(`mix-b-${i}`, 'fpdddddddd-4', `m${i}`, 0.7, i === 2 ? null : 0.5, i < 2 ? { unpriced: 1 } : {})
    }
    // A scorer error is no verdict: were it read as a fail, A's pass rate on m1 would drop.
    await insert('mix-a-err', 'fpcccccccc-3', 'm1', 0, 1, { error: 'scorer bug' })
    await insert('few-a-0', 'fpeeeeeeee-5', 'f0', 0.5, 1)
    await insert('few-b-0', 'fpffffffff-6', 'f0', 0.9, 0.5)
    const compare = async (a: string, b: string) =>
      (await rt.wait((await rt.start(evalCompare, { workflow: 'review', a, b }, { purpose: 'prod' })).runId))
        .output as Out
    const out = await compare('fpcccccccc', 'fpdddddddd')
    expect(out.cases).toMatchObject({ paired: 6, unpricedCost: { a: 0, b: 2 }, noCost: { a: 0, b: 1 } })
    expect(out.a).toMatchObject({ runs: 7, scorerErrors: 1 })
    expect(out.metrics.find((m: Out) => m.metric === 'pass')).toMatchObject({ n: 6, meanA: 0 })
    expect(out.metrics.find((m: Out) => m.metric === 'costUsd')).toMatchObject({ n: 3, better: 'unknown' })
    expect(out.warnings).toContain('arm A mixes scorer versions (r0, r1)')
    expect(out.warnings).toContain('1 scorer errors in A / 0 in B, left out')
    expect(out.warnings).toContain('costUsd: 3 pairs (fewer than 5), verdict withheld')
    expect(out.warnings).toContain(
      'cost compared on 3 of 6 paired cases (unpriced calls: 0 in A, 2 in B; no cost recorded: 0 in A, 1 in B)',
    )
    expect(out.bBetter).toEqual(['pass', 'recall'])
    const few = await compare('fpeeeeeeee', 'fpffffffff')
    expect(few.bBetter).toEqual([])
    expect(few.metrics.every((m: Out) => m.better === 'unknown')).toBe(true)
    expect(few.warnings).toContain('only 1 paired cases (fewer than 5): every verdict is withheld')
  })
})

describe('drift', () => {
  test('samples production runs and scores each once, however many jobs tick', async () => {
    const [checkWorkflow] = check.map((e) => e.workflow)
    if (!checkWorkflow) throw new Error('no check workflow')
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          await rt.start(
            checkWorkflow,
            { cwd: join(home, 'SourceRoot', 'demo'), commands: [`echo ${i}`] },
            { purpose: 'prod' },
          )
        ).runId,
      )
    }
    for (const id of ids) await rt.wait(id)
    const options = { ...driftOptionsFromEnv({}), rate: 1 }
    const logger = { warn: () => {}, error: () => {} }
    const one = new DriftJob(rt, options, logger)
    const two = new DriftJob(rt, options, logger)
    const [x, y] = await Promise.all([one.tick(), two.tick()])
    expect({ scored: x.scored + y.scored, errors: x.errors + y.errors }).toEqual({ scored: 3, errors: 0 })
    expect(await one.tick()).toEqual({ scored: 0, errors: 0 })
    // A recorded scorer error counts as an error, never as scored.
    const warned: string[] = []
    const broken = new DriftJob(
      {
        driftCandidates: async () => ['r-x', 'r-y'],
        scoreRun: async (id): Promise<FinalScore> =>
          id === 'r-x'
            ? { source: 'drift', scorer: 's', scores: {}, pass: null, error: 'bug', errorKind: 'scorer' }
            : { source: 'drift', scorer: 's', scores: { ok: 1 }, pass: true },
      },
      options,
      { warn: (message) => warned.push(message), error: () => {} },
    )
    expect(await broken.tick()).toEqual({ scored: 1, errors: 1 })
    expect(warned).toEqual(['drift: scorer errors recorded (no verdict)'])
    for (const id of ids) {
      expect(await sql.run(id)).toMatchObject({
        score_source: 'drift',
        scores: { final: { source: 'drift', pass: true } },
      })
    }
  })

  test('the rate comes from the environment and is checked', () => {
    expect(driftOptionsFromEnv({}).rate).toBe(0.1)
    expect(driftOptionsFromEnv({ AGW_DRIFT_RATE: '0.25', AGW_DRIFT_INTERVAL_S: '60' })).toMatchObject({
      rate: 0.25,
      intervalMs: 60_000,
    })
    expect(() => driftOptionsFromEnv({ AGW_DRIFT_RATE: '2' })).toThrow('AGW_DRIFT_RATE')
  })
})
