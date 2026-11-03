// A run tree's arm (`agw eval run --arm <file>`): stored on the row, copied to every descendant run, handed to every
// step (`scope.arm`), every agent session (`AgentOpenSpec.arm`), the middleware (`RunInfo.arm`) and `ctx.param`.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { type Arm, defineWorkflow, type Json, type Middleware, type RunPreArgs, WorkflowError } from '../src/index.ts'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { freshSchema, inspector, testRuntime } from './support/pg.ts'

const db = freshSchema('arm')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const ARM: Arm = { routes: { check: { effort: 'low' } }, params: { finders: 5 } }
const tagged = z.object({ tag: z.string() })

describe('an arm', () => {
  test('reaches the run, its parented case, the fan-out grandchild and their agent sessions; an unarmed run sees none', async () => {
    const seen: Record<string, { scope?: Arm; ctx?: Arm }> = {}
    const pre: Record<string, Arm | undefined> = {}
    const middleware: Middleware = { name: 'spy', runPre: (args) => void (pre[args.runId] = args.arm) }
    const host = new FakeAgentHost(async () => ({ output: 'ok' }))
    const leaf = defineWorkflow({
      id: 'arm.leaf',
      version: 'v1',
      input: tagged,
      output: z.object({}),
      async run(ctx, { tag }) {
        await ctx.step('see', (scope) => {
          seen[`leaf:${tag}`] = { ...(scope.arm ? { scope: scope.arm } : {}), ...(ctx.arm ? { ctx: ctx.arm } : {}) }
          return null
        })
        return {}
      },
    })
    const kase = defineWorkflow({
      id: 'arm.case',
      version: 'v1',
      input: tagged,
      output: z.object({}),
      async run(ctx, { tag }) {
        await ctx.agent('ask', { agent: 'a', prompt: tag })
        await ctx.workflow('fan', leaf, [{ tag }])
        return {}
      },
    })
    const root = defineWorkflow({
      id: 'arm.root',
      version: 'v1',
      input: z.object({ tag: z.string(), arm: z.custom<Arm>().optional() }),
      output: z.object({ caseRun: z.string() }),
      arm: (input) => input.arm,
      async run(ctx, { tag }) {
        await ctx.step('see', (scope) => {
          seen[`root:${tag}`] = { ...(scope.arm ? { scope: scope.arm } : {}), ...(ctx.arm ? { ctx: ctx.arm } : {}) }
          return null
        })
        // As `eval.run` starts a case: a child of this run that stays its own root.
        const { runId } = await rt.start(kase, { tag }, { purpose: 'eval', parentId: ctx.runId })
        await rt.wait(runId)
        return { caseRun: runId }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [root, kase, leaf], host, middleware: [middleware] })
    await rt.open()
    try {
      const [armed, plain] = await Promise.all([
        rt.start(root, { tag: 'armed', arm: ARM }, { purpose: 'eval' }),
        rt.start(root, { tag: 'plain' }, { purpose: 'prod' }),
      ])
      const ends = await Promise.all([rt.wait(armed.runId), rt.wait(plain.runId)])
      expect(ends.map((e) => e.status)).toEqual(['done', 'done'])

      expect(seen['root:armed']).toEqual({ scope: ARM, ctx: ARM })
      expect(seen['leaf:armed']).toEqual({ scope: ARM, ctx: ARM })
      expect(seen['root:plain']).toEqual({})
      expect(seen['leaf:plain']).toEqual({})

      const caseRun = (ends[0].output as { caseRun: string }).caseRun
      expect((await sql.run(armed.runId))?.arm).toEqual(ARM)
      expect((await sql.run(caseRun))?.arm).toEqual(ARM)
      expect((await sql.run(plain.runId))?.arm).toBeNull()
      const { rows } = await sql.pool.query(`select arm from "${db.schema}".runs where parent_id = $1`, [caseRun])
      expect(rows.map((r) => r.arm)).toEqual([ARM]) // the fan-out grandchild

      const sessions = [...host.sessions.values()]
      const opened = (tag: string) => sessions.find((s) => s.spec.prompt === tag)?.spec
      expect(opened('armed')?.arm).toEqual(ARM)
      expect(opened('plain')).not.toHaveProperty('arm')
      expect(pre[caseRun]).toEqual(ARM) // the parented case's admission sees the arm it inherited
    } finally {
      await rt.close()
    }
  })

  test('the middleware sees it on admission: absent for a run without one', async () => {
    const pre: RunPreArgs[] = []
    const middleware: Middleware = { name: 'spy', runPre: (args) => void pre.push(args) }
    const wf = defineWorkflow({
      id: 'arm.pre',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async () => ({}),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [middleware] })
    await rt.open()
    try {
      const a = await rt.start(wf, {}, { purpose: 'eval', arm: ARM })
      const b = await rt.start(wf, {}, { purpose: 'prod' })
      await Promise.all([rt.wait(a.runId), rt.wait(b.runId)])
      expect(pre.find((p) => p.runId === a.runId)?.arm).toEqual(ARM)
      expect(pre.find((p) => p.runId === b.runId)).not.toHaveProperty('arm')
    } finally {
      await rt.close()
    }
  })

  test('is refused next to a parent (a child runs on its tree’s arm) and when it is not an arm', async () => {
    const wf = defineWorkflow({
      id: 'arm.bad',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async () => ({}),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const parent = await rt.start(wf, {}, { purpose: 'eval', arm: ARM })
      const refused = async (options: Parameters<typeof rt.start>[2]) =>
        rt.start(wf, {}, options).then(
          () => 'started',
          (error: unknown) => (error instanceof WorkflowError ? `${error.kind}: ${error.message}` : String(error)),
        )
      expect(await refused({ purpose: 'eval', parentId: parent.runId, arm: ARM })).toBe(
        'invalid_input: start: parentId excludes arm',
      )
      for (const [arm, why] of [
        [[], 'arm is not an object'],
        [{ route: {} }, 'arm has unknown keys: route'],
        [{ routes: 'check' }, 'arm routes is not an object'],
        [{ params: { at: Number.NaN } }, 'arm.params.at is a non-finite number'],
      ] as const) {
        expect(await refused({ purpose: 'eval', arm: arm as unknown as Arm })).toContain(why)
      }
      // An arm whose routes and params are both empty is none: the unarmed baseline.
      for (const arm of [{}, { routes: {} }, { params: {} }, { routes: {}, params: {} }]) {
        const empty = await rt.start(wf, {}, { purpose: 'eval', arm })
        expect((await sql.run(empty.runId))?.arm).toBeNull()
        await rt.wait(empty.runId)
      }
      await rt.wait(parent.runId)
    } finally {
      await rt.close()
    }
  })
})

describe('an unarmed parented start', () => {
  test('stays a child of an armed parent but takes no arm, and passes none on', async () => {
    const seen: (Arm | undefined)[] = []
    const leaf = defineWorkflow({
      id: 'unarmed.leaf',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async (ctx) => {
        await ctx.step('see', (scope) => {
          seen.push(scope.arm)
          return null
        })
        return {}
      },
    })
    const judge = defineWorkflow({
      id: 'unarmed.judge',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async (ctx) => {
        await ctx.step('see', (scope) => {
          seen.push(scope.arm)
          return null
        })
        await ctx.workflow('fan', leaf, [{}])
        return {}
      },
    })
    const parent = defineWorkflow({
      id: 'unarmed.parent',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async () => ({}),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [parent, judge, leaf] })
    await rt.open()
    try {
      const p = await rt.start(parent, {}, { purpose: 'eval', arm: ARM })
      const j = await rt.start(judge, {}, { purpose: 'eval', parentId: p.runId, unarmed: true })
      expect((await rt.wait(j.runId)).status).toBe('done')
      expect(await sql.run(j.runId)).toMatchObject({ parent_id: p.runId, arm: null })
      expect(seen).toEqual([undefined, undefined])
      const refused = await rt.start(judge, {}, { purpose: 'eval', arm: ARM, unarmed: true }).then(
        () => 'started',
        (error: unknown) => String(error),
      )
      expect(refused).toContain('start: unarmed excludes an arm')
      await rt.wait(p.runId)
    } finally {
      await rt.close()
    }
  })
})

describe('ctx.param', () => {
  const run = async (arm: Arm | undefined, read: (param: (name: string, fallback: Json) => Json) => Json) => {
    const wf = defineWorkflow({
      id: `arm.param.${Bun.randomUUIDv7().slice(-8)}`,
      version: 'v1',
      input: z.object({}),
      output: z.object({ value: z.json() }),
      run: async (ctx) => ({ value: read((name, fallback) => ctx.param(name, fallback)) }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'eval', ...(arm ? { arm } : {}) })
      return await rt.wait(runId)
    } finally {
      await rt.close()
    }
  }

  test("returns the arm's value, else the default; typed as the default's type", async () => {
    const typed = (ctx: { param<T extends Json>(name: string, fallback: T): T extends number ? number : T }) => {
      const finders: number = ctx.param('finders', 3)
      return finders
    }
    expect(typeof typed).toBe('function')
    expect((await run(ARM, (param) => param('finders', 3))).output).toEqual({ value: 5 })
    expect((await run(ARM, (param) => param('voters', 3))).output).toEqual({ value: 3 })
    expect((await run(undefined, (param) => param('finders', 3))).output).toEqual({ value: 3 })
    const objects = { params: { voterMode: 'single', seats: ['a', 'b'], off: null } }
    expect(
      (await run(objects, (param) => [param('voterMode', 'agent'), param('seats', []), param('off', null)])).output,
    ).toEqual({
      value: ['single', ['a', 'b'], null],
    })
  })

  test('a value of another type fails the run as invalid_input, naming the param and both types', async () => {
    const end = await run({ params: { finders: 'five' } }, (param) => param('finders', 3))
    expect(end.status).toBe('failed')
    expect(end.error).toEqual({
      kind: 'invalid_input',
      message: 'arm param "finders" must be number (the default\'s type), got string',
    })
    const array = await run({ params: { seats: { a: 1 } } }, (param) => param('seats', []))
    expect(array.error?.message).toBe('arm param "seats" must be array (the default\'s type), got object')
  })
})
