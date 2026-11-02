// `agw eval run <workflow> --arm <file>`: the arm is in eval.run's input and fingerprint, refused at admission when
// bad, and applies to every run below the eval run (the case runs and their fan-out children) while a run outside it
// resolves the plain table. The judge, inline or regression, grades on the plain table even inside the eval.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineCapability } from '@agent-workflows/capabilities'
import { casesPath, PlainCase, writeCases } from '@agent-workflows/eval'
import { type PatchInput, type RouteId, resolveRoute } from '@agent-workflows/routes'
import { defineWorkflow, type Runtime, type ScoreJudge, WorkflowError } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import { testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'
import { createCapabilityWorkflows } from '../src/capability-runs.ts'
import { scorerJudge } from '../src/judge.ts'
import type { HostWorkflow } from '../src/operations.ts'
import { createEvalWorkflows, wireEval } from '../src/workflows/eval/index.ts'

const db = freshSchema('evalarm')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evalarm-'))
const env = { AGW_EVAL_DIR: join(root, 'eval'), AGW_EVAL_HOME: join(root, 'home'), AGW_DRIFT_RATE: '0' }

/** The patched routes: an agent route's effort and model, a single-call route's effort. */
const SONNET = resolveRoute('review.angle.deep').model
const ARM = { routes: { check: { model: SONNET, effort: 'max' }, 'cheap.classify': { effort: 'high' } } }

const Seen = z.object({ model: z.string(), effort: z.string().nullable() })
type Seen = z.infer<typeof Seen>
const seen = (id: RouteId, patch: PatchInput): Seen => {
  const route = resolveRoute(id, patch)
  return { model: route.model, effort: route.effort ?? null }
}

/** What the agent host resolves an agent step's route with: the arm its open spec carries. */
const host = new FakeAgentHost(async (session) => ({ output: seen('check', session.spec.arm?.routes) }))

/** The case run's child (the eval run's grandchild): a single-call route resolved in its step. */
const leaf = defineWorkflow({
  id: 'armcase.leaf',
  version: 'v1',
  input: z.object({}),
  output: Seen,
  run: (ctx) => ctx.step('resolve', (scope) => seen('cheap.classify', scope.arm?.routes)),
})

/** A judge capability: answers with the route its call resolved (with the arm the call carries, if any). */
const probe = defineCapability({
  id: 'llm.armprobe',
  summary: 'the route a judge call resolves',
  input: z.object({}),
  output: Seen,
  handler: (_input, ctx) => seen('cheap.classify', ctx.arm?.routes),
})
const capWorkflows = createCapabilityWorkflows({ served: [probe] })

/** 1 when the judge resolved the plain table. */
const judgedOnTable = async (judge: ScoreJudge | undefined) =>
  judge && JSON.stringify(await judge('llm.armprobe', {})) === JSON.stringify(seen('cheap.classify', undefined)) ? 1 : 0

/** The replayed workflow: an agent step, an inline gate, a route resolved outside any step, and a fan-out child. */
const target = defineWorkflow({
  id: 'armcase',
  version: 'v1',
  input: z.object({ n: z.number() }),
  output: z.object({ agent: Seen, outside: Seen, child: Seen }),
  scorer: {
    version: 's1',
    judgeInline: true,
    score: async (_input, _output, ctx) => ({ scores: { judgeOnTable: await judgedOnTable(ctx.judge) }, pass: true }),
  },
  async run(ctx) {
    const agent = Seen.parse(await ctx.agent('ask', { agent: 'checker', prompt: 'x' }))
    await ctx.score('gate', null)
    const [child] = await ctx.workflow('fan', leaf, [{}])
    return { agent, outside: seen('cheap.classify', ctx.arm?.routes), child: Seen.parse(child) }
  },
})

const evals = createEvalWorkflows(new Map([['armcase', 'plain' as const]]), { env, tmpRoot: join(root, 'tmp') })
const evalRun = (evals[0] as HostWorkflow).workflow
const workflows: HostWorkflow[] = [{ workflow: target }, { workflow: leaf, internal: true }, ...evals]

let rt: Runtime
let platform: ReturnType<typeof testPlatform>
let wiring: ReturnType<typeof wireEval>

beforeAll(async () => {
  writeCases(casesPath('armcase', env), PlainCase, [
    { id: 'c1', input: { n: 1 }, reference: null },
    { id: 'c2', input: { n: 2 }, reference: null },
  ])
  platform = testPlatform(db.schema)
  rt = testRuntime({
    schema: db.schema,
    workflows: [...workflows.map((w) => w.workflow), ...capWorkflows.values()],
    host,
    middleware: platform.middleware,
    judge: scorerJudge({
      registry: { call: (_id: never, input: never, options: never) => probe.call(input, options) },
      workflows: capWorkflows,
      runtime: () => rt,
    }),
  })
  wiring = wireEval({ runtime: rt, workflows, env })
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

// oxlint-disable-next-line typescript/no-explicit-any -- outputs are asserted field by field
type Out = Record<string, any>
async function evalOnce(input: Record<string, unknown>): Promise<{ runId: string; output: Out }> {
  const { runId } = await rt.start(evalRun, input, { purpose: 'prod' })
  const end = await rt.wait(runId)
  expect(end.error).toBeNull()
  return { runId, output: end.output as Out }
}

const table = { agent: seen('check', undefined), outside: seen('cheap.classify', undefined) }
const armed = { agent: seen('check', ARM.routes), outside: seen('cheap.classify', ARM.routes) }

describe('agw eval run --arm', () => {
  test('the patches are real moves off the table', () => {
    expect(armed.agent).toEqual({ model: SONNET, effort: 'max' })
    expect(armed.agent).not.toEqual(table.agent)
    expect(armed.outside).not.toEqual(table.outside)
  })

  test('case runs and their children resolve the patched routes; a concurrent run outside the arm resolves the table', async () => {
    const [evaluated, production] = await Promise.all([
      evalOnce({ workflow: 'armcase', yes: true, arm: ARM }),
      rt.start(target, { n: 9 }, { purpose: 'prod' }).then(async ({ runId }) => ({ runId, end: await rt.wait(runId) })),
    ])
    const { runId, output } = evaluated
    expect(output.summary).toMatchObject({ scored: 2, errors: 0 })
    for (const c of output.cases) {
      const row = await sql.run(c.runId)
      expect(row).toMatchObject({ parent_id: runId, arm: ARM })
      expect(row?.output).toEqual({ agent: armed.agent, outside: armed.outside, child: armed.outside })
      const { rows } = await sql.pool.query(`select arm from "${db.schema}".runs where parent_id = $1`, [c.runId])
      expect(rows.map((r) => r.arm)).toEqual([ARM]) // the grandchild carries it too
    }
    expect(production.end.output).toEqual({ agent: table.agent, outside: table.outside, child: table.outside })

    // The judge grades on the plain table: the inline gate in each armed case, and the regression scoring, whose calls
    // are children of the eval run (its cost) that do not inherit its arm.
    for (const c of output.cases) {
      const row = await sql.run(c.runId)
      expect(row?.scores).toMatchObject({ gates: { gate: { scores: { judgeOnTable: 1 } } } })
      expect(c.scores).toEqual({ judgeOnTable: 1 })
    }
    const { rows: judged } = await sql.pool.query(
      `select parent_id, arm from "${db.schema}".runs where workflow = 'cap.llm.armprobe' and purpose = 'eval'`,
    )
    expect(judged.length).toBeGreaterThan(0)
    for (const r of judged) expect(r).toEqual({ parent_id: runId, arm: null })
    expect((await sql.run(production.runId))?.arm).toBeNull()
  })

  test('the arm is in the eval run input and on its row, and it moves the fingerprints of the eval run and its cases', async () => {
    const plain = await evalOnce({ workflow: 'armcase', yes: true, ids: 'c1' })
    const withArm = await evalOnce({ workflow: 'armcase', yes: true, ids: 'c1', arm: ARM })
    const other = await evalOnce({ workflow: 'armcase', yes: true, ids: 'c1', arm: { params: { finders: 5 } } })
    const [plainRow, armRow, otherRow] = await Promise.all([plain, withArm, other].map((e) => sql.run(e.runId)))
    expect(armRow?.input).toMatchObject({ arm: ARM })
    expect(armRow?.arm).toEqual(ARM)
    expect(plainRow?.arm).toBeNull()
    expect(new Set([plainRow?.fingerprint, armRow?.fingerprint, otherRow?.fingerprint]).size).toBe(3)
    const caseFingerprints = [plain, withArm, other].map((e) => e.output.fingerprints[0])
    expect(new Set(caseFingerprints).size).toBe(3)
  })

  test('a bad arm is refused at admission, naming the route, before any run exists', async () => {
    const refused = async (arm: unknown) =>
      rt.start(evalRun, { workflow: 'armcase', yes: true, arm }, { purpose: 'prod' }).then(
        () => 'started',
        (error: unknown) => (error instanceof WorkflowError ? `${error.kind}: ${error.message}` : String(error)),
      )
    const { rows: before } = await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)
    expect(await refused({ routes: { 'no.such': { effort: 'low' } } })).toMatch(
      /invalid_input: .*unknown route "no\.such"/s,
    )
    expect(await refused({ routes: { 'review.synthesis': { effort: 'none' } } })).toMatch(
      /"review\.synthesis".*Sonnet/s,
    )
    expect(await refused({ routes: { check: { model: 'not-in-table' } } })).toContain(
      'route "check": model "not-in-table" is not in the route table (add it to the table first)',
    )
    const callOnly = resolveRoute('cheap.classify').fallback?.model as string
    expect(await refused({ routes: { check: { model: callOnly } } })).toContain(
      `route "check": model "${callOnly}" is not served by the OpenCode server`,
    )
    expect(await refused({ routes: { 'research.agent': { effort: 'xhigh' } } })).toMatch(
      /"research\.agent".*a DeepSeek model cannot run at effort xhigh/s,
    )
    expect(await refused({ routes: { check: { effort: 'leakysecret' } } })).not.toContain('leakysecret')
    expect(await refused({ params: {}, extra: true })).toContain('invalid_input')
    const { rows: after } = await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)
    expect(after[0].n).toBe(before[0].n)
  })
})
