import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow, type Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import type { ReadableSpan } from '@opentelemetry/sdk-trace'
import { z } from 'zod'
import { admissionSpanId, computeFingerprint, traceIdForRun, usageFromOpenCodeMessages } from '../src/index.ts'
import { cachedTurn } from './fixtures/opencode-messages.ts'
import {
  attr,
  defaultInputs,
  fakeFingerprint,
  freshSchema,
  inspector,
  parentOf,
  type TestPlatform,
  testPlatform,
  testRuntime,
  until,
} from './support.ts'

const db = freshSchema('mwp')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const n = z.object({ n: z.number() })

const priced = defineWorkflow({
  id: 'p.priced',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('a', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 100, output: 20, cacheRead: 40, reasoning: 5 }, cost: 0.01 })
      return 1
    })
    await ctx.step('b', ({ addUsage }) => {
      addUsage({ model: 'm2', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.02 })
      addUsage({ model: 'm2', tokens: { input: 1, output: 1, cacheRead: 0, reasoning: 0 }, cost: null })
      return 2
    })
    await ctx.agent('ask', { agent: 'brain', prompt: `q${n}` })
    return { n }
  },
})

const unpriced = defineWorkflow({
  id: 'p.unpriced',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('a', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 7, output: 3, cacheRead: 0, reasoning: 0 } })
      addUsage({ model: 'm1', tokens: { input: 7, output: 3, cacheRead: 0, reasoning: 0 }, cost: null })
      return 1
    })
    return { n }
  },
})

const child = defineWorkflow({
  id: 'p.child',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('work', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 10, output: 1, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
      return n
    })
    return { n }
  },
})

const fan = defineWorkflow({
  id: 'p.fan',
  version: 'v1',
  input: n,
  output: z.object({ sum: z.number() }),
  async run(ctx) {
    const kids = await ctx.workflow('kids', child, [{ n: 1 }, { n: 2 }, { n: 3 }])
    return { sum: kids.reduce((s, k) => s + (k?.n ?? 0), 0) }
  },
})

const host = new FakeAgentHost(async (s) => {
  await s.sleep(20)
  await s.tool('read', { path: 'a' }, 'content')
  await s.tool('grep', { q: 'b' }, 'hit')
  return { output: { ok: true }, usage: usageFromOpenCodeMessages(cachedTurn) }
})

async function settled(runId: string) {
  return until(async () => {
    const row = await sql.run(runId)
    return row?.post_hooks_at ? row : null
  }, `runPost of ${runId}`)
}

function byName(spans: ReadableSpan[], name: string) {
  return spans.filter((s) => s.name === name)
}

describe('platform middleware through a real runtime', () => {
  test('concurrent runs: run record, fingerprint, purpose and span tree', async () => {
    const platform = testPlatform(db.schema)
    const rt = testRuntime({
      schema: db.schema,
      workflows: [priced, unpriced, fan, child],
      host,
      middleware: platform.middleware,
    })
    await rt.open()
    try {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const starts = await Promise.all(
        Array.from({ length: 6 }, (_, i) => [
          rt.start(priced, { n: i }, { purpose: 'eval', traceparent }),
          rt.start(unpriced, { n: i }, { purpose: 'build' }),
          rt.start(fan, { n: i }, { purpose: 'prod' }),
        ]).flat(),
      )
      const results = await Promise.all(starts.map(({ runId }) => rt.wait(runId)))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      const rows = await Promise.all(starts.map(({ runId }) => settled(runId)))
      const fingerprint = computeFingerprint('v1', defaultInputs())

      for (const row of rows) {
        expect(row.fingerprint).toBe(fingerprint)
        expect(Number(row.wall_ms)).toBeGreaterThanOrEqual(0)
        if (row.workflow === 'p.priced') {
          expect(row).toMatchObject({
            trace_id: '0af7651916cd43dd8448eb211c80319c',
            tokens_input: String(100 + 11 + 257 + 21376),
            tokens_output: String(20 + 3 + 2),
            tokens_cache_read: String(40 + 21376),
            tokens_reasoning: '5',
            friction: { unpricedCalls: 1, toolCalls: 0 },
          })
          expect(Number(row.cost)).toBeCloseTo(0.01 + 0.02 + 0.000103878, 12)
        }
        if (row.workflow === 'p.unpriced') {
          expect(row).toMatchObject({
            cost: null,
            tokens_input: '14',
            friction: { unpricedCalls: 2 },
            trace_id: traceIdForRun({ rootId: String(row.id), traceparent: null }),
          })
        }
        if (row.workflow === 'p.fan') expect(row).toMatchObject({ tokens_input: '0', cost: null })
      }
      const kid = await settled(`${starts[2]?.runId}/kids/0`)
      expect(kid).toMatchObject({ tokens_input: '10', fingerprint, trace_id: rows[2]?.trace_id })

      await platform.telemetry.flush()
      const spans = platform.spans.getFinishedSpans()
      expect(byName(spans, 'agw.run p.priced')).toHaveLength(6)
      expect(byName(spans, 'agw.run p.child')).toHaveLength(18)
      expect(platform.logger.lines.filter((l) => !l.message.startsWith('argo outbox off'))).toEqual([])

      // A run with the caller's traceparent: parented to it, the admission span id derived from the run id.
      const pricedId = starts[0]?.runId ?? ''
      const run = spans.find((s) => attr(s, 'agw.run.id') === pricedId && s.name.startsWith('agw.run'))
      if (!run) throw new Error('no run span')
      expect(run.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c')
      expect(parentOf(run)).toBe('b7ad6b7169203331')
      expect(run.spanContext().spanId).toBe(admissionSpanId(pricedId))
      expect(run.attributes).toMatchObject({
        'agw.purpose': 'eval',
        'agw.fingerprint': fingerprint,
        'agw.run.status': 'done',
        'agw.run.resumed': false,
        'agw.cost.unpriced_calls': 1,
      })
      const steps = spans.filter((s) => s.name.startsWith('agw.step') && attr(s, 'agw.run.id') === pricedId)
      expect(steps.map((s) => attr(s, 'agw.step.id')).sort()).toEqual(['a', 'ask', 'b'])
      expect(steps.every((s) => parentOf(s) === run.spanContext().spanId)).toBe(true)
      const ask = steps.find((s) => attr(s, 'agw.step.id') === 'ask')
      expect(ask?.attributes).toMatchObject({
        'agw.step.kind': 'agent',
        'agw.step.attempt': 1,
        'agw.step.replay': false,
        'agw.tokens.input': 257 + 21376,
        'agw.tokens.cache_read': 21376,
        'agw.cost.usd': 0.000103878,
        'gen_ai.request.model': 'deepseek-v4.1-flash',
      })
      expect(String(ask?.attributes['opencode.session.id'])).toMatch(/^ses_\d+$/)
      expect(ask?.events.map((e) => [e.name, e.attributes?.['agw.tool.name']])).toEqual([
        ['tool.pre', 'read'],
        ['tool.post', 'read'],
        ['tool.pre', 'grep'],
        ['tool.post', 'grep'],
      ])

      // A fan-out: the derived trace; child runs under the fan-out step span, their steps under them.
      const fanId = starts[2]?.runId ?? ''
      const fanSpan = spans.find((s) => attr(s, 'agw.run.id') === fanId && s.name.startsWith('agw.run'))
      if (!fanSpan) throw new Error('no fan span')
      expect(fanSpan.spanContext().traceId).toBe(traceIdForRun({ rootId: fanId, traceparent: null }))
      expect(parentOf(fanSpan)).toBeUndefined()
      const kids = spans.find((s) => attr(s, 'agw.run.id') === fanId && attr(s, 'agw.step.id') === 'kids')
      const children = spans.filter((s) => s.name === 'agw.run p.child' && attr(s, 'agw.run.parent_id') === fanId)
      expect(children).toHaveLength(3)
      for (const c of children) {
        expect(parentOf(c)).toBe(kids?.spanContext().spanId)
        expect(c.spanContext().traceId).toBe(fanSpan.spanContext().traceId)
        const work = spans.find((s) => attr(s, 'agw.run.id') === attr(c, 'agw.run.id') && s.name === 'agw.step work')
        expect(parentOf(work as ReadableSpan)).toBe(c.spanContext().spanId)
      }
    } finally {
      await rt.close()
      await platform.close()
    }
  })

  test('runPost re-delivered: the record is the same, a run span for the outcome', async () => {
    const platform = testPlatform(db.schema)
    const rt = testRuntime({ schema: db.schema, workflows: [unpriced], middleware: platform.middleware })
    await rt.open()
    try {
      const { runId } = await rt.start(unpriced, { n: 1 }, { purpose: 'build' })
      await rt.wait(runId)
      const first = await settled(runId)
      const runPost = platform.middleware.find((m) => m.name === 'record')?.runPost
      const telemetryPost = platform.middleware.find((m) => m.name === 'telemetry')?.runPost
      const args = {
        runId,
        workflowId: 'p.unpriced',
        version: 'v1',
        purpose: 'build',
        parentId: null,
        rootId: runId,
        input: { n: 1 },
        traceparent: null,
        status: 'done' as const,
        output: { n: 1 },
        error: null,
        startedAt: first.started_at as Date,
        finishedAt: first.finished_at as Date,
      }
      await runPost?.(args)
      await telemetryPost?.(args)
      const again = await sql.run(runId)
      for (const key of ['wall_ms', 'tokens_input', 'tokens_output', 'cost', 'friction', 'trace_id', 'fingerprint']) {
        expect(again?.[key]).toEqual(first[key])
      }
      await platform.telemetry.flush()
      const spans = byName(platform.spans.getFinishedSpans(), 'agw.run p.unpriced')
      expect(spans).toHaveLength(2)
      expect(spans[1]?.attributes).toMatchObject({ 'agw.run.outcome_only': true, 'agw.run.status': 'done' })
      expect(spans[1]?.spanContext().traceId).toBe(spans[0]?.spanContext().traceId)
      expect(spans[1]?.links[0]?.context.spanId).toBe(admissionSpanId(runId))
    } finally {
      await rt.close()
      await platform.close()
    }
  })

  test('a blank purpose is refused at admission', async () => {
    const platform = testPlatform(db.schema)
    const rt = testRuntime({ schema: db.schema, workflows: [unpriced], middleware: platform.middleware })
    await rt.open()
    try {
      const { runId } = await rt.start(unpriced, { n: 1 }, { purpose: ' ' })
      expect(await rt.wait(runId)).toMatchObject({ status: 'failed', error: { kind: 'admission_refused' } })
    } finally {
      await rt.close()
      await platform.close()
    }
  })
})

describe('resume', () => {
  let release = false
  const gated = defineWorkflow({
    id: 'p.gated',
    version: 'v1',
    input: n,
    output: n,
    async run(ctx, { n }) {
      await ctx.step('one', () => 1)
      await ctx.step('two', async ({ signal, addUsage }) => {
        while (!release) {
          if (signal.aborted) throw signal.reason
          await Bun.sleep(10)
        }
        addUsage({ model: 'm1', tokens: { input: 3, output: 1, cacheRead: 0, reasoning: 0 }, cost: 0.003 })
        return 2
      })
      return { n }
    },
  })

  async function driveAndClose(): Promise<{ platform: TestPlatform; rt: Runtime; ids: string[] }> {
    const platform = testPlatform(db.schema)
    const rt = testRuntime({ schema: db.schema, workflows: [gated], middleware: platform.middleware })
    await rt.open()
    const ids = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => (await rt.start(gated, { n: i }, { purpose: 'build' })).runId),
    )
    await until(async () => {
      const steps = await Promise.all(ids.map((id) => sql.step(id, 'two')))
      return steps.every((s) => s?.status === 'running')
    }, 'every run inside step two')
    await rt.close()
    await platform.close()
    return { platform, rt, ids }
  }

  test('a resumed run keeps its admission fingerprint and opens a linked run span in the same trace', async () => {
    release = false
    const first = await driveAndClose()
    const admitted = computeFingerprint('v1', defaultInputs())

    // The next process runs on changed inputs (an AGENTS.md edit): new runs would get another fingerprint.
    const changed = fakeFingerprint()
    changed.current = {
      ...defaultInputs(),
      agents: [{ name: 'brain', files: { 'AGENTS.md': '# v2' }, route: 'route-fp-1' }],
    }
    expect(computeFingerprint('v1', changed.current)).not.toBe(admitted)
    release = true
    const second = testPlatform(db.schema, { fingerprint: changed })
    const rt = testRuntime({ schema: db.schema, workflows: [gated], middleware: second.middleware })
    await rt.open()
    try {
      const results = await Promise.all(first.ids.map((id) => rt.wait(id)))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      for (const id of first.ids) {
        const row = await settled(id)
        expect(row.fingerprint).toBe(admitted)
        expect(row).toMatchObject({ tokens_input: '3', cost: '0.003' })
      }

      const before = first.platform.spans.getFinishedSpans()
      await second.telemetry.flush()
      const after = second.spans.getFinishedSpans()
      for (const id of first.ids) {
        const original = before.find((s) => s.name === 'agw.run p.gated' && attr(s, 'agw.run.id') === id)
        const resumed = after.find((s) => s.name === 'agw.run p.gated' && attr(s, 'agw.run.id') === id)
        if (!original || !resumed) throw new Error(`spans missing for ${id}`)
        expect(original.spanContext().spanId).toBe(admissionSpanId(id))
        expect(original.attributes).toMatchObject({ 'agw.suspended': true, 'agw.run.resumed': false })
        expect(resumed.spanContext().traceId).toBe(original.spanContext().traceId)
        expect(resumed.spanContext().spanId).not.toBe(original.spanContext().spanId)
        expect(resumed.links.map((l) => l.context.spanId)).toEqual([admissionSpanId(id)])
        expect(resumed.attributes).toMatchObject({
          'agw.run.resumed': true,
          'agw.run.status': 'done',
          'agw.fingerprint': admitted,
          'agw.purpose': 'build',
        })
        const two = after.find((s) => s.name === 'agw.step two' && attr(s, 'agw.run.id') === id)
        expect(two?.attributes).toMatchObject({ 'agw.step.replay': true, 'agw.step.attempt': 2 })
        expect(parentOf(two as ReadableSpan)).toBe(resumed.spanContext().spanId)
        expect(after.some((s) => s.name === 'agw.step one' && attr(s, 'agw.run.id') === id)).toBe(false)
      }
    } finally {
      await rt.close()
      await second.close()
    }
  })
})
