import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GtCase, gtPath, type JudgeClass, type JudgeInput, writeCases } from '@agent-workflows/eval'
import { IdempotencyConflict, type Json, type JudgeCaller, type Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createEvalWorkflows, wireEval } from '../src/workflows/eval/index.ts'
import { hostModules, suitesOf } from '../src/workflows/index.ts'
import { createImportedReviewWorkflow } from '../src/workflows/review/imported.ts'
import { REVIEW_SCORER_VERSION, reviewScorer } from '../src/workflows/review/scorer.ts'
import { applyVerdictRules } from '../src/workflows/review/verdict.ts'
import { testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

const HOST_SUITES = suitesOf(await hostModules())

const db = freshSchema('evalimp')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evalimp-'))
const home = join(root, 'home')
const env = { AGW_EVAL_DIR: join(root, 'eval'), AGW_EVAL_HOME: home, AGW_DRIFT_RATE: '0' }
const originalHome = process.env.HOME
const ZEROS = '0'.repeat(40)

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString())
  return ran.stdout.toString().trim()
}

const gt = (id: string, sha: string, kind: 'bug' | 'control') => ({
  id,
  kind,
  split: 'dev',
  repo: 'SourceRoot/fixture',
  sha,
  parent: ZEROS,
  subject: 'feat: cart total',
  minerVersion: 'm1',
  ...(kind === 'bug'
    ? {
        candidateId: id,
        bug: {
          location: { file: 'src/cart.ts', startLine: 1, endLine: 1 },
          description: 'reduce without an initial value throws on an empty cart',
          bugClass: 'edge-case',
          severity: 'major',
          fixSha: sha,
          fixSubject: 'fix: empty cart',
        },
      }
    : {}),
})

/** What the fake judge says about a finding, by case and finding id (default `unclear`). */
const CLASSES: Record<string, Record<string, JudgeClass>> = {
  'bug-hit': { '0': 'match', '1': 'not-a-bug' },
  'bug-nit': { '0': 'match' },
  'control-alarm': { '0': 'real' },
}
const judgeCalls: JudgeInput[] = []
const judge: JudgeCaller = async (capability, raw): Promise<Json> => {
  const input = raw as unknown as JudgeInput
  expect(capability).toBe('eval.judge')
  judgeCalls.push(input)
  return {
    findings: input.findings.map((f) => ({ id: f.id, class: CLASSES[input.caseId]?.[f.id] ?? 'unclear', reason: 'r' })),
    model: 'fake',
  }
}

type Finding = {
  file: string
  line?: number
  endLine?: number
  message: string
  tag: 'important' | 'nit' | 'pre-existing'
}
const FINDINGS: Record<string, Finding[]> = {
  'bug-hit': [
    { file: 'src/cart.ts', line: 1, message: 'reduce on an empty array throws', tag: 'important' },
    { file: 'src/other.ts', line: 4, message: 'rename this', tag: 'nit' },
  ],
  'bug-nit': [{ file: 'src/cart.ts', line: 1, message: 'reduce needs an initial value', tag: 'nit' }],
  'control-alarm': [{ file: 'src/cart.ts', message: 'looks risky', tag: 'important' }],
}

let sha: string
let nativeFingerprint = ''
let rt: Runtime
let wiring: ReturnType<typeof wireEval>
let platform: ReturnType<typeof testPlatform>
const evals = createEvalWorkflows(HOST_SUITES, { env, tmpRoot: join(root, 'tmp') })
const imported = createImportedReviewWorkflow()
const evalImport = evals.find((e) => e.workflow.id === 'eval.import')?.workflow as (typeof evals)[0]['workflow']

beforeAll(async () => {
  const repo = join(home, 'SourceRoot', 'fixture')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'cart.ts'), 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b)\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'feat: cart total')
  sha = git(repo, 'rev-parse', 'HEAD')
  process.env.HOME = home // the scorer reads the commit's diff from $HOME/<repo>
  writeCases(gtPath('cases.jsonl', env), GtCase, [
    gt('bug-hit', sha, 'bug'),
    gt('bug-nit', sha, 'bug'),
    gt('bug-missing', sha, 'bug'),
    gt('control-alarm', sha, 'control'),
    gt('control-quiet', sha, 'control'),
    gt('toString', sha, 'control'), // an Object.prototype key is a case id like any other
  ])
  platform = testPlatform(db.schema)
  rt = testRuntime({
    schema: db.schema,
    workflows: [imported, ...evals].map((e) => e.workflow),
    host: new FakeAgentHost(async () => {
      throw new Error('an import runs no agent')
    }),
    middleware: platform.middleware,
    judge,
  })
  wiring = wireEval({ runtime: rt, workflows: [imported, ...evals], env })
  await rt.open()
})

afterAll(async () => {
  process.env.HOME = originalHome
  await wiring.close()
  await rt.close()
  await platform.close()
  await sql.close()
  await db.drop()
  rmSync(root, { recursive: true, force: true })
})

// oxlint-disable-next-line typescript/no-explicit-any -- outputs are asserted field by field
type Out = Record<string, any>
async function importOnce(input: Record<string, unknown>, key?: string) {
  const { runId } = await rt.start(evalImport, input, { purpose: 'prod', ...(key ? { idempotencyKey: key } : {}) })
  const end = await rt.wait(runId)
  return { runId, output: end.output as Out, error: end.error?.message ?? null }
}

const children = async (evalRunId: string) =>
  (await sql.pool.query(`select * from "${db.schema}".runs where parent_id = $1 order by idempotency_key`, [evalRunId]))
    .rows as Record<string, any>[] // oxlint-disable-line typescript/no-explicit-any

const base = { workflow: 'review', label: 'native-high', findings: FINDINGS }

describe('agw eval import review', () => {
  test('without --yes: the plan, the missing cases and the judge calls; nothing runs', async () => {
    const { runId, output, error } = await importOnce(base)
    expect(error).toBeNull()
    expect(output).toMatchObject({
      ran: false,
      label: 'native-high',
      plan: {
        ids: ['bug-hit', 'bug-nit', 'control-alarm'],
        missing: ['bug-missing', 'control-quiet', 'toString'],
        findings: 4,
        judgeCalls: 3,
      },
      cases: [],
    })
    expect(await children(runId)).toEqual([])
    expect(judgeCalls).toHaveLength(0)
  })

  test('scores like the same findings as a review output; case runs are children, regression, scorer v3', async () => {
    const { runId, output, error } = await importOnce({ ...base, yes: true })
    expect(error).toBeNull()
    expect(output.ran).toBe(true)
    expect(output.summary).toMatchObject({ scored: 3, errors: 0, skipped: 0 })
    expect(output.fingerprints).toHaveLength(1)
    nativeFingerprint = output.fingerprints[0]
    expect(judgeCalls).toHaveLength(3)

    // The same findings as REVIEW_OUTPUT v2, through the scorer directly with the same judge.
    const asReview = (list: Finding[]) => {
      const f = (x: Finding) => ({
        file: x.file,
        message: x.message,
        angle: 'native-high',
        ...(x.line === undefined ? {} : { line: x.line }),
      })
      return {
        ...applyVerdictRules(
          {
            outcome: 'actionable' as const,
            blocking: list.filter((x) => x.tag === 'important').map(f),
            improvements: list.filter((x) => x.tag !== 'important').map(f),
            discussions: [],
            testGaps: [],
            summary: 'x',
          },
          [],
          6,
        ).verdict,
        schemaVersion: 2,
      }
    }
    for (const c of output.cases) {
      expect(c).toMatchObject({ status: 'scored', runStatus: 'done' })
      const expected = await reviewScorer.score({} as never, asReview(FINDINGS[c.caseId] as Finding[]), {
        source: 'regression',
        signal: new AbortController().signal,
        reference: GtCase.parse(gt(c.caseId, sha, c.caseId.startsWith('bug') ? 'bug' : 'control')),
        judge: (capability, input) => judge(capability, input, {} as never),
      })
      expect(c.scores).toEqual(expected.scores)
      expect(c.pass).toBe(expected.pass)
    }
    const byId = Object.fromEntries(output.cases.map((c: Out) => [c.caseId, c]))
    expect(byId['bug-hit'].scores).toMatchObject({ recall: 1, detected: 1, complete: 1 })
    expect(byId['bug-nit'].scores).toMatchObject({ recall: 0, detected: 1, severityCalibration: 0 })
    expect(byId['control-alarm'].scores).toMatchObject({ falseAlarms: 1, clean: 0 })

    const kids = await children(runId)
    expect(kids).toHaveLength(3)
    for (const kid of kids) {
      expect(kid).toMatchObject({
        workflow: 'review.imported',
        purpose: 'eval',
        score_source: 'regression',
        root_id: kid.id,
        fingerprint: output.fingerprints[0],
        scores: { final: { source: 'regression', scorer: REVIEW_SCORER_VERSION, args: {} } },
      })
    }
    expect(kids.map((k) => k.idempotency_key)).toEqual([
      `eval:${runId}:bug-hit`,
      `eval:${runId}:bug-nit`,
      `eval:${runId}:control-alarm`,
    ])
  })

  test('the fingerprint differs per label and is stable for the same label', async () => {
    const a1 = await importOnce({ ...base, label: 'arm-a', yes: true, ids: 'bug-hit' })
    const a2 = await importOnce({ ...base, label: 'arm-a', yes: true, ids: 'bug-hit' })
    const b = await importOnce({ ...base, label: 'arm-b', yes: true, ids: 'bug-hit' })
    expect(a1.output.fingerprints).toEqual(a2.output.fingerprints)
    expect(b.output.fingerprints[0]).not.toBe(a1.output.fingerprints[0])
  })

  test('the same import started again with its idempotency key adopts the first: no new case runs, no new judge calls', async () => {
    const input = { ...base, label: 'idem', yes: true }
    const first = await importOnce(input, 'import-idem')
    const before = judgeCalls.length
    const again = await rt.start(evalImport, input, { purpose: 'prod', idempotencyKey: 'import-idem' })
    expect(again.runId).toBe(first.runId)
    expect(await children(first.runId)).toHaveLength(3)
    expect(judgeCalls).toHaveLength(before)
    const conflict = await rt
      .start(evalImport, { ...input, label: 'other' }, { purpose: 'prod', idempotencyKey: 'import-idem' })
      .catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(IdempotencyConflict)
  })

  test('a bad finding or an unknown case id refuses the import before any case run starts', async () => {
    const opened = judgeCalls.length
    const bad = await importOnce({
      ...base,
      yes: true,
      findings: {
        ...FINDINGS,
        'bug-nit': [{ file: 'src/cart.ts', message: 'x', tag: 'critical' }, FINDINGS['bug-hit']?.[0]],
      },
    })
    expect(bad.error).toContain('case bug-nit, finding 0')
    const unknown = await importOnce({ ...base, yes: true, findings: { ...FINDINGS, ghost: [], phantom: [] } })
    expect(unknown.error).toContain('unknown case ids: ghost, phantom')
    for (const refused of [bad, unknown]) expect(await children(refused.runId)).toEqual([])
    expect(judgeCalls).toHaveLength(opened)
    const range = await importOnce({
      ...base,
      yes: true,
      findings: { 'bug-hit': [{ file: 'src/cart.ts', line: 5, endLine: 2, message: 'x', tag: 'nit' }] },
    })
    expect(range.error).toContain('case bug-hit, finding 0')
  })

  test('a case with no findings is scored without a judge call', async () => {
    const before = judgeCalls.length
    const { output, error } = await importOnce({
      workflow: 'review',
      label: 'quiet',
      findings: { 'control-quiet': [], 'bug-nit': [] },
      yes: true,
    })
    expect(error).toBeNull()
    expect(judgeCalls).toHaveLength(before)
    const byId = Object.fromEntries(output.cases.map((c: Out) => [c.caseId, c]))
    expect(byId['control-quiet']).toMatchObject({ status: 'scored', pass: true })
    expect(byId['control-quiet'].scores).toMatchObject({ falseAlarms: 0, clean: 1, findings: 0 })
    expect(byId['bug-nit']).toMatchObject({ status: 'scored', pass: false })
    expect(byId['bug-nit'].scores).toMatchObject({ recall: 0, detected: 0 })
  })
})

describe('agw eval compare with an imported arm', () => {
  const insert = (id: string, caseId: string, recall: number) =>
    sql.pool.query(
      `insert into "${db.schema}".runs (id, workflow, root_id, purpose, input, input_hash, lock_key, version_started,
         status, fingerprint, cost, wall_ms, tokens_input, tokens_output, tool_calls, unpriced_calls, scores,
         score_source, scored_at, finished_at)
       values ($1, 'review', $1, 'eval', '{}', 'h', 1, 'v', 'done', 'fpreview00-1', 0.5, 1000, 100, 10, 4, 0, $2,
         'regression', now(), now())`,
      [
        id,
        JSON.stringify({
          final: {
            source: 'regression',
            scorer: REVIEW_SCORER_VERSION,
            caseId,
            scores: { recall },
            pass: recall > 0.6,
          },
        }),
      ],
    )

  test('pairs the imported arm with a review arm by case id; its cost and wall are null, not 0', async () => {
    for (const caseId of ['bug-hit', 'bug-nit', 'control-alarm']) await insert(`syn-${caseId}`, caseId, 0.5)
    const { runId } = await rt.start(
      (evals.find((e) => e.workflow.id === 'eval.compare') as (typeof evals)[0]).workflow,
      { workflow: 'review', a: 'fpreview00', b: nativeFingerprint.slice(0, 12), bWorkflow: 'review.imported' },
      { purpose: 'prod' },
    )
    const out = (await rt.wait(runId)).output as Out
    expect(out.cases).toMatchObject({ a: 3, b: 3, paired: 3, onlyA: [], onlyB: [] })
    expect(out.b).toMatchObject({ workflow: 'review.imported', fingerprint: nativeFingerprint })
    expect(out.a).toMatchObject({ workflow: 'review', fingerprint: 'fpreview00-1' })
    for (const metric of ['costUsd', 'wallMs', 'tokens', 'toolCalls']) {
      expect(out.metrics.find((m: Out) => m.metric === metric)).toMatchObject({ n: 0, meanB: null, better: 'unknown' })
    }
    expect(out.metrics.find((m: Out) => m.metric === 'recall')).toMatchObject({ n: 2, meanA: 0.5, meanB: 0.5 })
    expect(out.warnings).toContain('arm B is an imported arm: cost and wall are not measured')
    expect(out.a.scorers).toEqual([REVIEW_SCORER_VERSION])
    expect(out.b.scorers).toEqual([REVIEW_SCORER_VERSION])
  })

  test('without bWorkflow the imported arm is not found under review', async () => {
    const { runId } = await rt.start(
      (evals.find((e) => e.workflow.id === 'eval.compare') as (typeof evals)[0]).workflow,
      { workflow: 'review', a: 'fpreview00', b: nativeFingerprint.slice(0, 12) },
      { purpose: 'prod' },
    )
    expect((await rt.wait(runId)).error?.message).toContain('arm B: no regression runs')
  })
})
