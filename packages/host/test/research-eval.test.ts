import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casesPath } from '@agent-workflows/eval'
import { defineWorkflow, type Json, type Runtime } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../src/operations.ts'
import { createEvalWorkflows, wireEval } from '../src/workflows/eval/index.ts'
import { readSuite } from '../src/workflows/eval/suites.ts'
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
})

test("the host's judge calls a registry capability by id with the scoring step's usage and signal", async () => {
  const { registryJudge } = await import('../src/boot.ts')
  const calls: unknown[] = []
  const registry = {
    async call(id: string, input: Json, options: { addUsage: unknown; signal: AbortSignal }) {
      calls.push([id, input, typeof options.addUsage, options.signal.aborted])
      return { ok: true }
    },
  }
  const judge = registryJudge(registry as never)
  expect(
    await judge(
      'web.fetch',
      { url: 'https://example.com' },
      { addUsage: () => {}, signal: new AbortController().signal },
    ),
  ).toEqual({ ok: true })
  expect(calls).toEqual([['web.fetch', { url: 'https://example.com' }, 'function', false]])
})
