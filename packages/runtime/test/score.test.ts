import { afterAll, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { z } from 'zod'
import { defineWorkflow, type Json, type Scorer } from '../src/index.ts'
import { migrate } from '../src/migrate.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { freshSchema, inspector, PG_URL, testRuntime, until } from './support/pg.ts'

const db = freshSchema('score')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const draft = z.object({ body: z.string() })

/** Passes a draft that mentions "fixed"; counts its calls. */
function countingScorer(): Scorer<{ topic: string }> & { calls: number } {
  const scorer = {
    version: 's1',
    calls: 0,
    score(input: { topic: string }, output: Json) {
      scorer.calls++
      const parsed = draft.safeParse(output)
      const ok = parsed.success && parsed.data.body.includes('fixed')
      return {
        scores: { valid: parsed.success ? 1 : 0, mentions: ok ? 1 : 0, topic: input.topic.length },
        pass: ok,
        ...(ok ? {} : { feedback: 'say fixed' }),
      }
    },
  }
  return scorer
}

describe('ctx.score (inline gate)', () => {
  test('runs the scorer as a journaled code step and keeps the verdict on the run', async () => {
    const scorer = countingScorer()
    const wf = defineWorkflow({
      id: 'score.gate',
      version: 'v1',
      input: z.object({ topic: z.string() }),
      output: z.object({ pass: z.boolean() }),
      scorer,
      async run(ctx) {
        const verdict = await ctx.score('gate', { body: 'not yet' })
        return { pass: verdict.pass }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, { topic: 'abc' }, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ pass: false })
      const verdict = { scores: { valid: 1, mentions: 0, topic: 3 }, pass: false, feedback: 'say fixed' }
      expect(await sql.step(runId, 'gate')).toMatchObject({ kind: 'code', status: 'done', output: verdict })
      expect((await sql.run(runId))?.scores).toEqual({ gates: { gate: verdict } })
      expect(scorer.calls).toBe(1)
    } finally {
      await rt.close()
    }
  })

  test('a resumed run returns the recorded verdict and does not score again', async () => {
    const scorer = countingScorer()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const wf = defineWorkflow({
      id: 'score.resume',
      version: 'v1',
      input: z.object({ topic: z.string() }),
      output: z.object({ pass: z.boolean() }),
      scorer,
      async run(ctx) {
        const verdict = await ctx.score('gate', { body: 'fixed it' })
        await ctx.step('after', async ({ signal }) => {
          await Promise.race([held, new Promise((_, reject) => signal.addEventListener('abort', reject))])
          return true
        })
        return { pass: verdict.pass }
      },
    })
    const first = testRuntime({ schema: db.schema, workflows: [wf] })
    await first.open()
    const { runId } = await first.start(wf, { topic: 't' }, { purpose: 'build' })
    await until(async () => (await sql.step(runId, 'after'))?.status === 'running', 'after running')
    await first.close()
    release()
    const second = testRuntime({ schema: db.schema, workflows: [wf] })
    await second.open()
    try {
      expect((await second.wait(runId)).output).toEqual({ pass: true })
      expect(scorer.calls).toBe(1)
      expect(await sql.step(runId, 'gate')).toMatchObject({ attempts: 1 })
    } finally {
      await second.close()
    }
  })

  test('no scorer, or a malformed verdict, fails the step', async () => {
    const bare = defineWorkflow({
      id: 'score.none',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      async run(ctx) {
        await ctx.score('gate', 1)
        return {}
      },
    })
    const broken = defineWorkflow({
      id: 'score.broken',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      scorer: { version: 'b', score: () => ({ scores: { x: Number.NaN }, pass: true }) },
      async run(ctx) {
        await ctx.score('gate', 1)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [bare, broken] })
    await rt.open()
    try {
      const a = await rt.wait((await rt.start(bare, {}, { purpose: 'build' })).runId)
      expect(a.error?.message).toContain('has no scorer')
      const b = await rt.wait((await rt.start(broken, {}, { purpose: 'build' })).runId)
      expect(b.error?.message).toContain('non-finite score "x"')
      expect(await sql.step(b.runId, 'gate')).toMatchObject({ status: 'failed', error_kind: 'invalid_output' })
    } finally {
      await rt.close()
    }
  })

  test('judge reaches the inline gate only with judgeInline', async () => {
    const seen: (string | null)[] = []
    const make = (id: string, judgeInline: boolean) =>
      defineWorkflow({
        id,
        version: 'v1',
        input: z.object({}),
        output: z.object({}),
        scorer: {
          version: 'j',
          judgeInline,
          async score(_input, _output, ctx) {
            seen.push(ctx.judge ? JSON.stringify(await ctx.judge('llm.decide', { q: 1 })) : null)
            return { scores: {}, pass: true }
          },
        },
        async run(ctx) {
          await ctx.score('gate', 1)
          return {}
        },
      })
    const off = make('score.judge-off', false)
    const on = make('score.judge-on', true)
    const usage = { tokens: { input: 1, output: 1, cacheRead: 0, reasoning: 0 }, cost: 0.5 }
    const rt = testRuntime({
      schema: db.schema,
      workflows: [off, on],
      judge: async (capability, input, scope) => {
        scope.addUsage(usage)
        return { capability, input }
      },
    })
    await rt.open()
    try {
      await rt.wait((await rt.start(off, {}, { purpose: 'build' })).runId)
      const { runId } = await rt.start(on, {}, { purpose: 'build' })
      await rt.wait(runId)
      expect(seen).toEqual([null, JSON.stringify({ capability: 'llm.decide', input: { q: 1 } })])
      expect(await sql.step(runId, 'gate')).toMatchObject({ cost: '0.5' })
    } finally {
      await rt.close()
    }
  })
})

describe('ctx.continue', () => {
  const gated = (id: string) =>
    defineWorkflow({
      id,
      version: 'v1',
      input: z.object({ topic: z.string() }),
      output: draft,
      scorer: countingScorer(),
      async run(ctx, { topic }) {
        let body = await ctx.agent('draft', { agent: 'writer', prompt: `write about ${topic}`, output: draft })
        const verdict = await ctx.score('gate', body)
        if (!verdict.pass) {
          body = (await ctx.continue('draft:reask', body, verdict.feedback ?? 'again')) as z.output<typeof draft>
        }
        return body
      },
    })

  test('re-prompts the same session with the feedback, journaled as a new agent step', async () => {
    const host = new FakeAgentHost(async (s) => ({ output: { body: s.turnOf ? `fixed: ${s.sent}` : 'draft one' } }))
    const wf = gated('continue.same')
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, { topic: 'x' }, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ body: 'fixed: say fixed' })
      expect(host.events.map((e) => e.op)).toEqual(['open', 'prompt', 'followUp', 'prompt'])
      const turn = [...host.sessions.values()].find((s) => s.turnOf)
      expect(turn?.root.id).toBe('ses_1')
      expect(turn?.spec).toMatchObject({ runId, stepId: 'draft:reask', key: `${runId}:draft:reask` })
      expect(await sql.step(runId, 'draft:reask')).toMatchObject({
        kind: 'agent',
        status: 'done',
        handle: { handle: { sessionId: turn?.id }, prompted: true },
      })
    } finally {
      await rt.close()
    }
  })

  test('validates the turn against the earlier step schema; a step id works for text answers', async () => {
    const host = new FakeAgentHost(async (s) => ({ output: s.turnOf ? 'plain text' : { body: 'draft' } }))
    const wf = gated('continue.schema')
    const text = defineWorkflow({
      id: 'continue.text',
      version: 'v1',
      input: z.object({}),
      output: z.object({ text: z.string() }),
      async run(ctx) {
        await ctx.agent('ask', { agent: 'writer', prompt: 'hi' })
        return { text: String(await ctx.continue('ask:reask', 'ask', 'and more')) }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf, text], host })
    await rt.open()
    try {
      const bad = await rt.wait((await rt.start(wf, { topic: 'x' }, { purpose: 'build' })).runId)
      expect(bad.error?.message).toContain('agent step "draft:reask"')
      expect(await sql.step(bad.runId, 'draft:reask')).toMatchObject({ status: 'failed', error_kind: 'invalid_output' })
      const ok = await rt.wait((await rt.start(text, {}, { purpose: 'build' })).runId)
      expect(ok.output).toEqual({ text: 'plain text' })
    } finally {
      await rt.close()
    }
  })

  test('an unknown `from` or a host without followUp fails the step', async () => {
    const wild = defineWorkflow({
      id: 'continue.unknown',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      async run(ctx) {
        await ctx.continue('ask:reask', { body: 'x' }, 'again')
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wild], host: new FakeAgentHost() })
    await rt.open()
    try {
      const run = await rt.wait((await rt.start(wild, {}, { purpose: 'build' })).runId)
      expect(run.error?.message).toContain('neither a step id nor an agent step output')
    } finally {
      await rt.close()
    }

    class Plain extends FakeAgentHost {}
    // biome-ignore lint/suspicious/noExplicitAny: removing an optional method for the test
    ;(Plain.prototype as any).followUp = undefined
    const wf = gated('continue.nohost')
    const plain = testRuntime({
      schema: db.schema,
      workflows: [wf],
      host: new Plain(async () => ({ output: { body: 'd' } })),
    })
    await plain.open()
    try {
      const run = await plain.wait((await plain.start(wf, { topic: 'x' }, { purpose: 'build' })).runId)
      expect(run.error?.message).toContain('ctx.continue is unsupported')
    } finally {
      await plain.close()
    }
  })

  test('a resumed continue step re-attaches to its turn: one followUp, one prompt', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.turnOf) return { output: { body: 'draft' } }
      await s.sleep(400)
      return { output: { body: 'fixed late' } }
    })
    const wf = gated('continue.resume')
    const first = testRuntime({ schema: db.schema, workflows: [wf], host })
    await first.open()
    const { runId } = await first.start(wf, { topic: 'x' }, { purpose: 'build' })
    await until(
      async () => ((await sql.step(runId, 'draft:reask'))?.handle as { prompted?: boolean } | null)?.prompted,
      'turn prompted',
    )
    await first.close()
    const second = testRuntime({ schema: db.schema, workflows: [wf], host })
    await second.open()
    try {
      expect((await second.wait(runId)).output).toEqual({ body: 'fixed late' })
      expect(host.count('followUp')).toBe(1)
      expect(host.count('prompt', 'sent')).toBe(2)
    } finally {
      await second.close()
    }
  })
})

describe('after-the-fact scoring', () => {
  const reviewish = (id: string) =>
    defineWorkflow({
      id,
      version: 'v1',
      input: z.object({ n: z.number(), fail: z.boolean().default(false) }),
      output: z.object({ n: z.number() }),
      scorer: {
        version: 'ref1',
        reference: z.object({ expected: z.number() }),
        score(input, output, ctx) {
          if (input.n === 13) throw new Error('unlucky')
          const got = (output as { n?: number } | null)?.n ?? null
          const hit = ctx.reference ? Number(got === ctx.reference.expected) : 1
          return { scores: { hit, valid: Number(got !== null) }, pass: hit === 1 }
        },
      },
      async run(ctx, { n, fail }) {
        const value = await ctx.step('compute', () => {
          if (fail) throw new Error('nope')
          return n
        })
        return { n: value }
      },
    })

  test('regression: scored against the reference; a failed run scores as a miss; a thrower is recorded', async () => {
    const wf = reviewish('after.regression')
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const done = (await rt.start(wf, { n: 2 }, { purpose: 'eval' })).runId
      const failed = (await rt.start(wf, { n: 2, fail: true }, { purpose: 'eval' })).runId
      const thrower = (await rt.start(wf, { n: 13 }, { purpose: 'eval' })).runId
      for (const id of [done, failed, thrower]) await rt.wait(id)
      const meta = { source: 'regression' as const, caseId: 'c1', evalRunId: 'e1', args: { arm: 'a' } }
      expect(await rt.scoreRun(done, { ...meta, reference: { expected: 2 } })).toEqual({
        scores: { hit: 1, valid: 1 },
        pass: true,
        scorer: 'ref1',
        ...meta,
      })
      expect(await rt.scoreRun(failed, { ...meta, reference: { expected: 2 } })).toMatchObject({
        scores: { hit: 0, valid: 0 },
        pass: false,
      })
      expect(await rt.scoreRun(thrower, { ...meta, reference: { expected: 13 } })).toMatchObject({
        scores: {},
        pass: false,
        error: 'unlucky',
      })
      const bad = await rt.scoreRun(done, { ...meta, reference: { wrong: true } })
      expect(bad?.error).toContain('expected')
      const row = await sql.run(failed)
      expect(row).toMatchObject({ score_source: 'regression', scores: { final: { caseId: 'c1', pass: false } } })
      expect(row?.scored_at).toBeInstanceOf(Date)

      const scored = await rt.scoredRuns({ workflow: wf.id, source: 'regression' })
      expect(scored.map((r) => r.runId).sort()).toEqual([done, failed, thrower].sort())
      expect(scored.find((r) => r.runId === failed)?.final.args).toEqual({ arm: 'a' })
    } finally {
      await rt.close()
    }
  })

  test('drift: a deterministic sample, scored once; scoring re-queues synced Argo rows', async () => {
    const wf = reviewish('after.drift')
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const ids: string[] = []
      for (let n = 0; n < 40; n++) ids.push((await rt.start(wf, { n }, { purpose: 'prod' })).runId)
      const evalRun = (await rt.start(wf, { n: 1 }, { purpose: 'eval' })).runId
      for (const id of [...ids, evalRun]) await rt.wait(id)
      const since = new Date(Date.now() - 60_000)

      expect(await rt.driftCandidates({ rate: 0, since, limit: 100 })).toEqual([])
      const all = await rt.driftCandidates({ rate: 1, since, limit: 100, workflows: [wf.id] })
      expect(all.sort()).toEqual([...ids].sort()) // prod only
      const half = await rt.driftCandidates({ rate: 0.5, since, limit: 100, workflows: [wf.id] })
      expect(half.length).toBeGreaterThan(5)
      expect(half.length).toBeLessThan(35)
      expect(await rt.driftCandidates({ rate: 0.5, since, limit: 100, workflows: [wf.id] })).toEqual(half)
      // A smaller rate is a subset: the sample is a threshold on a hash of the id.
      const tenth = await rt.driftCandidates({ rate: 0.1, since, limit: 100, workflows: [wf.id] })
      expect(tenth.every((id) => half.includes(id))).toBe(true)

      const target = half[0] as string
      await sql.pool.query(
        `update "${db.schema}".steps set tokens_input = 5, argo_synced_at = now() where run_id = $1`,
        [target],
      )
      const first = await rt.scoreRun(target, { source: 'drift', onlyUnscored: true })
      expect(first).toMatchObject({ source: 'drift', pass: true })
      expect(await rt.scoreRun(target, { source: 'drift', onlyUnscored: true })).toBeNull()
      expect(await rt.driftCandidates({ rate: 0.5, since, limit: 100, workflows: [wf.id] })).not.toContain(target)
      expect((await sql.step(target, 'compute'))?.argo_synced_at).toBeNull()
    } finally {
      await rt.close()
    }
  })

  test('a cancelled or unfinished run is not scored', async () => {
    const wf = reviewish('after.pending')
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    const { runId } = await rt.start(wf, { n: 1 }, { purpose: 'prod' }) // never opened: stays pending
    expect(await rt.scoreRun(runId, { source: 'drift' })).toBeNull()
    await rt.cancel(runId)
    expect(await rt.scoreRun(runId, { source: 'drift' })).toBeNull()
    await rt.close()
  })
})

describe('review fixes', () => {
  const judged = (id: string, onJudge: () => void = () => {}) =>
    defineWorkflow({
      id,
      version: 'v1',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      scorer: {
        version: 'j1',
        async score(input, _output, ctx) {
          onJudge()
          // A scorer that swallows the judge failure still must not get its verdict recorded.
          const said = await ctx.judge?.('llm.decide', { n: input.n }).catch(() => null)
          return { scores: { judged: said === null ? 0 : 1 }, pass: said !== null }
        },
      },
      run: async (_ctx, { n }) => ({ n }),
    })

  test('a judge failure is rethrown and nothing is written: drift tries again next tick', async () => {
    let down = true
    const wf = judged('fix.judge')
    const rt = testRuntime({
      schema: db.schema,
      workflows: [wf],
      judge: async () => {
        if (down) throw new Error('judge endpoint 503')
        return { ok: true }
      },
    })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, { n: 1 }, { purpose: 'prod' })
      await rt.wait(runId)
      const since = new Date(Date.now() - 60_000)
      const refused = await rt.scoreRun(runId, { source: 'drift', onlyUnscored: true }).then(
        () => null,
        (e: Error) => e.message,
      )
      expect(refused).toContain('judge endpoint 503')
      expect(await sql.run(runId)).toMatchObject({ scores: null, score_source: null, scored_at: null })
      expect(await rt.driftCandidates({ rate: 1, since, limit: 10, workflows: [wf.id] })).toContain(runId)
      down = false
      expect(await rt.scoreRun(runId, { source: 'drift', onlyUnscored: true })).toMatchObject({
        scores: { judged: 1 },
        pass: true,
      })
    } finally {
      await rt.close()
    }
  })

  test('drift samples top-level runs only; scoredRuns narrows by run ids, fingerprint prefix and exact args', async () => {
    const leaf = defineWorkflow({
      id: 'fix.leaf',
      version: 'v1',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      scorer: { version: 'l1', score: () => ({ scores: { ok: 1 }, pass: true }) },
      run: async (_ctx, { n }) => ({ n }),
    })
    const parent = defineWorkflow({
      id: 'fix.parent',
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      async run(ctx) {
        await ctx.workflow('kids', leaf, [{ n: 1 }])
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [leaf, parent] })
    await rt.open()
    try {
      const top = (await rt.start(leaf, { n: 2 }, { purpose: 'prod' })).runId
      const tree = (await rt.start(parent, {}, { purpose: 'prod' })).runId
      await rt.wait(top)
      await rt.wait(tree)
      const since = new Date(Date.now() - 60_000)
      expect(await rt.driftCandidates({ rate: 1, since, limit: 10, workflows: [leaf.id] })).toEqual([top])

      const ids: string[] = []
      for (let n = 0; n < 3; n++) ids.push((await rt.start(leaf, { n }, { purpose: 'eval' })).runId)
      for (const id of ids) await rt.wait(id)
      await sql.pool.query(`update "${db.schema}".runs set fingerprint = 'fp-' || id where id = any($1)`, [ids])
      const [x, y, z2] = ids as [string, string, string]
      await rt.scoreRun(x, { source: 'regression', caseId: 'c', args: { arm: 'b', k: 1 } })
      await rt.scoreRun(y, { source: 'regression', caseId: 'c', args: {} })
      await rt.scoreRun(z2, { source: 'regression', caseId: 'c' })
      const pick = (filter: Partial<Parameters<typeof rt.scoredRuns>[0]>) =>
        rt.scoredRuns({ workflow: leaf.id, source: 'regression', ...filter }).then((r) => r.map((row) => row.runId))
      expect(await pick({ runIds: [y, 'nope'] })).toEqual([y])
      expect(await pick({ fingerprintPrefix: `fp-${x}` })).toEqual([x])
      expect(await pick({ args: { k: 1, arm: 'b' } })).toEqual([x]) // key order does not matter
      expect((await pick({ args: {} })).sort()).toEqual([y, z2].sort()) // no args recorded reads as {}
    } finally {
      await rt.close()
    }
  })

  test('a rejected duplicate agent step id does not replace the accepted step spec', async () => {
    const host = new FakeAgentHost(async (s) => ({ output: s.turnOf ? 'not a draft' : { body: 'first' } }))
    const wf = defineWorkflow({
      id: 'fix.duplicate',
      version: 'v1',
      input: z.object({}),
      output: z.object({ kind: z.string() }),
      async run(ctx) {
        const first = await ctx.agent('draft', { agent: 'writer', prompt: 'p', output: draft })
        await ctx.agent('draft', { agent: 'writer', prompt: 'p', output: z.string() }).catch(() => null)
        // The turn answers a string: valid for the rejected spec, invalid for the accepted one.
        const error = await ctx.continue('draft:reask', first, 'again').then(
          () => 'accepted',
          (e: Error) => e.message,
        )
        return { kind: error }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const end = await rt.wait(runId)
      expect((end.output as { kind: string }).kind).toContain('agent step "draft:reask"')
      expect(await sql.step(runId, 'draft:reask')).toMatchObject({ error_kind: 'invalid_output' })
    } finally {
      await rt.close()
    }
  })

  test('runByKey finds a keyed run with its final score', async () => {
    const wf = judged('fix.key')
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      expect(await rt.runByKey(wf.id, 'k1')).toBeNull()
      const { runId } = await rt.start(wf, { n: 1 }, { purpose: 'eval', idempotencyKey: 'k1' })
      await rt.wait(runId)
      expect(await rt.runByKey(wf.id, 'k1')).toMatchObject({ runId, status: 'done', final: null, error: null })
      await rt.scoreRun(runId, { source: 'regression', caseId: 'c1' })
      expect((await rt.runByKey(wf.id, 'k1'))?.final).toMatchObject({ caseId: 'c1', scores: { judged: 1 } })
    } finally {
      await rt.close()
    }
  })
})

describe('migration 0004_scores', () => {
  test('applies on a fresh schema and on one that has 0001–0003', async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 })
    const fresh = freshSchema('mig_fresh')
    const old = freshSchema('mig_old')
    try {
      expect(await migrate(pool, fresh.schema)).toContain('0004_scores.sql')

      const dir = new URL('../src/migrations/', import.meta.url)
      const early = (await readdir(dir)).filter((f) => /^000[1-3]_.+\.sql$/.test(f)).sort()
      expect(early).toHaveLength(3)
      await pool.query(`create schema "${old.schema}"`)
      await pool.query(
        `create table "${old.schema}".schema_migrations (version text primary key, applied_at timestamptz not null default now())`,
      )
      for (const file of early) {
        await pool.query((await Bun.file(new URL(file, dir)).text()).replaceAll('{{schema}}', `"${old.schema}"`))
        await pool.query(`insert into "${old.schema}".schema_migrations (version) values ($1)`, [file])
      }
      await pool.query(
        `insert into "${old.schema}".runs (id, workflow, root_id, purpose, input, input_hash, lock_key, version_started, status)
         values ('r1', 'w', 'r1', 'prod', '{}', 'h', 1, 'v1', 'done')`,
      )
      const applied = await migrate(pool, old.schema)
      expect(applied.filter((f) => f.startsWith('0004'))).toEqual(['0004_scores.sql'])
      const { rows } = await pool.query(`select scores, score_source, scored_at from "${old.schema}".runs`)
      expect(rows).toEqual([{ scores: null, score_source: null, scored_at: null }])
    } finally {
      await pool.end()
      await fresh.drop()
      await old.drop()
    }
  })
})
