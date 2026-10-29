import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineCapability, fail } from '@agent-workflows/capabilities'
import { casesPath } from '@agent-workflows/eval'
import { defineWorkflow, type Json, type Runtime } from '@agent-workflows/runtime'
import { z } from 'zod'
import { createCapabilityWorkflows } from '../src/capability-runs.ts'
import { answerOf, judgeAllowed, scorerJudge } from '../src/judge.ts'
import type { HostWorkflow } from '../src/operations.ts'
import { createEvalWorkflows, wireEval } from '../src/workflows/eval/index.ts'
import { readSuite } from '../src/workflows/eval/suites.ts'
import { rejection, until } from './support.ts'
import { testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

// A suite without a tree (`PlainCase`): the case input runs as recorded, `--args` win, nothing is materialized.
const db = freshSchema('evalplain')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evalplain-'))
const tmpRoot = join(root, 'tmp')
const env = { AGW_EVAL_DIR: join(root, 'eval'), AGW_EVAL_HOME: join(root, 'home'), AGW_DRIFT_RATE: '0' }

const seen: Json[] = []
const target: HostWorkflow = {
  workflow: defineWorkflow({
    id: 'research',
    version: 't1',
    input: z.object({ query: z.string(), depth: z.string(), design: z.string().optional() }),
    output: z.object({ answer: z.string() }),
    scorer: {
      version: 's1',
      reference: z.object({ want: z.string() }),
      score: (_input, output, ctx) => {
        const pass = (output as { answer?: string } | null)?.answer === ctx.reference?.want
        return { scores: { golden: pass ? 1 : 0 }, pass }
      },
    },
    async run(_ctx, input) {
      seen.push(input as Json)
      return { answer: input.query.includes('5432') ? '5432' : 'no' }
    },
  }),
  summary: 'fake research',
}

let rt: Runtime
let platform: ReturnType<typeof testPlatform>
let wiring: ReturnType<typeof wireEval>
const evals = createEvalWorkflows({ env, tmpRoot })
const evalRun = evals[0]?.workflow as NonNullable<(typeof evals)[0]>['workflow']

beforeAll(async () => {
  mkdirSync(tmpRoot)
  const path = casesPath('research', env)
  mkdirSync(join(env.AGW_EVAL_DIR, 'research'), { recursive: true })
  writeFileSync(
    path,
    [
      { id: 'port', input: { query: 'port 5432?', depth: 'quick' }, reference: { want: '5432' } },
      { id: 'miss', input: { query: 'other', depth: 'standard' }, reference: { want: '5432' } },
    ]
      .map((c) => JSON.stringify(c))
      .join('\n'),
  )
  platform = testPlatform(db.schema)
  rt = testRuntime({
    schema: db.schema,
    workflows: [target, ...evals].map((e) => e.workflow),
    middleware: platform.middleware,
  })
  wiring = wireEval({ runtime: rt, workflows: [target, ...evals], env })
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

test('readSuite: a plain case carries no tree; its input runs as recorded and the arm args win', () => {
  const [first] = readSuite('research', env)
  expect(first?.tree).toBeNull()
  expect(first?.input('/ignored', { depth: 'deep', design: 'agent' })).toEqual({
    query: 'port 5432?',
    depth: 'deep',
    design: 'agent',
  })
})

test('agw eval run on a tree-less suite: every case runs with the arm args and is scored', async () => {
  const { runId } = await rt.start(
    evalRun,
    { workflow: 'research', yes: true, args: { design: 'pilot' } },
    { purpose: 'prod' },
  )
  const end = await rt.wait(runId)
  expect(end.status).toBe('done')
  const out = end.output as { cases: { caseId: string; status: string; pass?: boolean }[] }
  expect(out.cases.map((c) => [c.caseId, c.status, c.pass])).toEqual([
    ['port', 'scored', true],
    ['miss', 'scored', false],
  ])
  expect(seen).toContainEqual({ query: 'port 5432?', depth: 'quick', design: 'pilot' })

  // The comparison's report reads every case run by its key: a scorer error is unscored (left out), never a miss.
  const { load } = await import('../src/workflows/research/compare.ts')
  const byCase = async () =>
    Object.fromEntries(
      (await load(sql.pool, db.schema, [runId])).map((l) => [l.row.caseId, [l.row.arm, l.row.golden, l.unscored]]),
    )
  expect(await byCase()).toEqual({ port: ['pilot-yolo', 1, false], miss: ['pilot-yolo', 0, false] })
  await sql.pool.query(
    `update "${db.schema}".runs set scores = jsonb_set(scores, '{final}', (scores->'final') || '{"error":"judge outage","scores":{}}')
      where idempotency_key = $1`,
    [`eval:${runId}:miss`],
  )
  expect((await byCase()).miss).toEqual(['pilot-yolo', null, true])

  // A cancelled (or still running) run is a miss, not ok, and its partial cost stays out of every median.
  await sql.pool.query(`update "${db.schema}".runs set status = 'cancelled', cost = 9 where idempotency_key = $1`, [
    `eval:${runId}:port`,
  ])
  const port = (await load(sql.pool, db.schema, [runId])).find((l) => l.row.caseId === 'port')
  expect(port).toMatchObject({ state: 'incomplete', status: 'cancelled', unscored: false, tokens: null })
  expect(port?.row).toMatchObject({ ok: false, cost: null, wallMs: null })
  // The id is a prefix, not a pattern: a `_` matches itself only.
  expect(await load(sql.pool, db.schema, [`${runId.slice(0, -1)}_`])).toEqual([])
})

describe("the scorers' judge", () => {
  const pageCap = defineCapability({
    id: 'web.fetch',
    summary: 'fake page fetch',
    input: z.object({ url: z.string() }),
    output: z.object({ url: z.string(), text: z.string() }),
    async handler({ url }, ctx) {
      ctx.addUsage({
        model: 'tavily',
        tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
        cost: 0.002,
        costSource: 'rate',
      })
      if (url.includes('gone')) throw fail('UPSTREAM_ERROR', 'the page is gone', { status: 404 })
      if (url.includes('down')) throw fail('UPSTREAM_ERROR', 'the site answered 503', { status: 503 })
      if (url.includes('refused')) throw fail('URL_REFUSED', 'a private address')
      if (url.includes('crash')) throw new Error('the fetcher crashed')
      if (url.includes('slow'))
        await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
      return { url, text: 'page text' }
    },
  })
  const capWorkflows = createCapabilityWorkflows({ capabilities: [pageCap] })
  let jrt: Runtime
  let jplatform: ReturnType<typeof testPlatform>
  const jdb = freshSchema('judge')
  const jsql = inspector(jdb.schema)
  const registry = { call: (_id: string, input: Json) => Promise.resolve({ inline: input }) }
  const judge = () => scorerJudge({ registry, workflows: capWorkflows, runtime: () => jrt })
  const scope = (
    source: 'regression' | 'drift' | 'inline',
    runId = 'scored-1',
    signal = new AbortController().signal,
  ) => ({
    addUsage: () => {},
    signal,
    source,
    runId,
    scorer: 's1',
  })
  const capRuns = async (url: string) =>
    (
      await jsql.pool.query(
        `select status from "${jdb.schema}".runs where workflow = 'cap.web.fetch' and input->>'url' = $1 order by started_at`,
        [url],
      )
    ).rows.map((r) => r.status as string)

  beforeAll(async () => {
    jplatform = testPlatform(jdb.schema)
    jrt = testRuntime({ schema: jdb.schema, workflows: [...capWorkflows.values()], middleware: jplatform.middleware })
    await jrt.open()
  })
  afterAll(async () => {
    await jrt.close()
    await jplatform.close()
    await jsql.close()
    await jdb.drop()
  })

  test('regression and drift: each call is a cap run, priced, with purpose eval or drift', async () => {
    expect(await judge()('web.fetch', { url: 'https://example.com/a' }, scope('regression'))).toEqual({
      url: 'https://example.com/a',
      text: 'page text',
    })
    await judge()('web.fetch', { url: 'https://example.com/b' }, scope('drift'))
    const { rows } = await jsql.pool.query(
      `select purpose, status, cost from "${jdb.schema}".runs where workflow = 'cap.web.fetch' order by started_at`,
    )
    expect(rows.map((r) => [r.purpose, r.status, Number(r.cost)])).toEqual([
      ['eval', 'done', 0.002],
      ['drift', 'done', 0.002],
    ])
  })

  test("a capability's gone answer is an answer; a call outside the allowlist is refused", async () => {
    expect(await judge()('web.fetch', { url: 'https://example.com/gone' }, scope('regression'))).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'the page is gone' },
    })
    expect(rejection(judge()('eval.run', {}, scope('regression')))).resolves.toContain('is not a judge capability')
    expect(judgeAllowed('llm.classify')).toBe(true)
    expect(judgeAllowed('review.adversary')).toBe(false)
  })

  test('a retried scoring adopts the finished call; another scored run or scorer version runs it fresh', async () => {
    const url = 'https://example.com/keyed'
    await judge()('web.fetch', { url }, scope('regression', 'scored-7'))
    await judge()('web.fetch', { url }, scope('regression', 'scored-7'))
    expect(await capRuns(url)).toEqual(['done'])
    await judge()('web.fetch', { url }, scope('regression', 'scored-8'))
    expect(await capRuns(url)).toEqual(['done', 'done'])
    await judge()('web.fetch', { url }, { ...scope('drift', 'scored-8'), scorer: 's2' })
    expect(await capRuns(url)).toEqual(['done', 'done', 'done'])
  })

  test('a key whose call failed is stepped past: the retried scoring runs the call again', async () => {
    const url = 'https://example.com/gone-twice'
    const typed = { error: { code: 'UPSTREAM_ERROR', message: 'the page is gone' } }
    expect(await judge()('web.fetch', { url }, scope('regression', 'scored-10'))).toEqual(typed)
    // A gone page is a final answer: the retried scoring adopts it.
    expect(await judge()('web.fetch', { url }, scope('regression', 'scored-10'))).toEqual(typed)
    expect(await capRuns(url)).toEqual(['failed'])
  })

  test('an outage (a defined code, but no answer) throws and is stepped past; a refused URL is an answer', async () => {
    const url = 'https://example.com/down'
    expect(await rejection(judge()('web.fetch', { url }, scope('regression', 'scored-14')))).toContain('503')
    expect(await rejection(judge()('web.fetch', { url }, scope('regression', 'scored-14')))).toContain('503')
    expect(await capRuns(url)).toEqual(['failed', 'failed'])
    const refused = 'https://example.com/refused'
    const answer = { error: { code: 'URL_REFUSED', message: 'a private address' } }
    expect(await judge()('web.fetch', { url: refused }, scope('regression', 'scored-14'))).toEqual(answer)
    expect(await judge()('web.fetch', { url: refused }, scope('regression', 'scored-14'))).toEqual(answer)
    expect(await capRuns(refused)).toEqual(['failed'])
  })

  test('answerOf: only gone (404, 410) and refused are answers', () => {
    const of = (code: string, data?: unknown) => answerOf({ code, message: 'm', data }) !== null
    expect(of('UPSTREAM_ERROR', { status: 404 })).toBe(true)
    expect(of('UPSTREAM_ERROR', { status: 410 })).toBe(true)
    expect(of('URL_REFUSED')).toBe(true)
    expect(of('UPSTREAM_ERROR', { status: 503 })).toBe(false)
    expect(of('UPSTREAM_ERROR', {})).toBe(false)
    expect(of('NOT_CONFIGURED')).toBe(false)
    expect(of('CANCELLED')).toBe(false)
    expect(of('INTERNAL_SERVER_ERROR')).toBe(false)
    expect(answerOf(null)).toBeNull()
  })

  test('an untyped failure is stepped past: the retried scoring runs the call again', async () => {
    const url = 'https://example.com/crash'
    expect(await rejection(judge()('web.fetch', { url }, scope('regression', 'scored-12')))).toContain(
      'INTERNAL_SERVER_ERROR',
    )
    expect(await rejection(judge()('web.fetch', { url }, scope('regression', 'scored-12')))).toContain(
      'INTERNAL_SERVER_ERROR',
    )
    expect(await capRuns(url)).toEqual(['failed', 'failed'])
  })

  test('each drift pass (UTC day) fetches fresh; a regression retry adopts', async () => {
    const url = 'https://example.com/drift'
    const at = (day: string) =>
      scorerJudge({ registry, workflows: capWorkflows, runtime: () => jrt, now: () => new Date(`${day}T12:00:00Z`) })
    await at('2026-10-29')('web.fetch', { url }, scope('drift', 'scored-13'))
    await at('2026-10-29')('web.fetch', { url }, scope('drift', 'scored-13'))
    await at('2026-10-30')('web.fetch', { url }, scope('drift', 'scored-13'))
    expect(await capRuns(url)).toEqual(['done', 'done'])
  })

  test('an abort that came before the start still cancels the call it started', async () => {
    const url = 'https://example.com/slow-late'
    const controller = new AbortController()
    const realStart = jrt.start.bind(jrt)
    const racing = scorerJudge({
      registry,
      workflows: capWorkflows,
      runtime: () => ({
        start: async (...args: Parameters<typeof realStart>) => {
          const started = await realStart(...args)
          controller.abort(new Error('aborted during start'))
          return started
        },
        wait: jrt.wait.bind(jrt),
        cancel: jrt.cancel.bind(jrt),
        runByKey: jrt.runByKey.bind(jrt),
      }),
    })
    expect(
      await rejection(racing('web.fetch', { url }, scope('regression', 'scored-11', controller.signal))),
    ).toContain('aborted during start')
    await until(async () => (await capRuns(url))[0] === 'cancelled', 'the call cancelled')
  })

  test('an aborted scoring cancels the call it started; the next scoring runs it again', async () => {
    const url = 'https://example.com/slow'
    const controller = new AbortController()
    const pending = judge()('web.fetch', { url }, scope('regression', 'scored-9', controller.signal))
    await until(async () => (await capRuns(url)).length === 1, 'the call started')
    controller.abort(new Error('scoring shut down'))
    expect(await rejection(pending)).toContain('scoring shut down')
    await until(async () => (await capRuns(url))[0] === 'cancelled', 'the call cancelled')
  })

  test('the inline gate calls in process, on its own step', async () => {
    expect(await judge()('decide', { state: 's' }, scope('inline'))).toEqual({ inline: { state: 's' } })
  })
})
