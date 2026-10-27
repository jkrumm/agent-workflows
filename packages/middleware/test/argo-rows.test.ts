import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  ArgoUsageRecordInput,
  additiveTokens,
  argoRowsForStep,
  httpArgoTransport,
  type OutboxStep,
  traceIdForRun,
} from '../src/index.ts'

const startedAt = new Date('2026-10-27T10:00:00.000Z')

function step(overrides: Partial<OutboxStep> = {}, run: Partial<OutboxStep['run']> = {}): OutboxStep {
  return {
    runId: 'run_1',
    stepId: 'ask',
    status: 'done',
    model: 'deepseek-v4.1-flash',
    tokens: { input: 2000, output: 340, cacheRead: 800, cacheWrite: 0, reasoning: 300 },
    cost: 0.0021,
    toolCalls: 2,
    unpricedCalls: 0,
    byModel: {
      'deepseek-v4.1-flash': {
        tokens: { input: 2000, output: 340, cacheRead: 800, cacheWrite: 0, reasoning: 300 },
        cost: 0.0021,
        toolCalls: 2,
        unpricedCalls: 0,
      },
    },
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1500),
    sessionId: 'ses_1',
    ...overrides,
    run: {
      workflowId: 'research.report',
      rootId: 'run_1',
      purpose: 'build',
      traceparent: null,
      traceId: null,
      fingerprint: 'fp1',
      friction: { unpricedCalls: 0 },
      status: 'done',
      errorKind: null,
      wallMs: 4000,
      ...run,
    },
  }
}

const opts = { machine: 'test-machine', now: new Date('2026-10-27T11:00:00.000Z') }
const ArgoBody = z.object({ records: z.array(ArgoUsageRecordInput).min(1).max(1000) })

describe('argo rows', () => {
  test('one row per step and model, keyed run:step:model, validated by Argo’s own schema', () => {
    const rows = argoRowsForStep(step(), opts)
    expect(ArgoBody.safeParse({ records: rows }).success).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'agent-workflows',
      source_id: 'run_1:ask:deepseek-v4.1-flash',
      grain: 'step',
      ts: startedAt.toISOString(),
      sub_tool: 'research.report',
      machine: 'test-machine',
      billing: 'iu',
      workspace: 'private',
      outcome: 'ok',
      duration_ms: 1500,
      cost_usd: 0.0021,
      cost_source: 'reported',
      raw: {
        runId: 'run_1',
        stepId: 'ask',
        purpose: 'build',
        fingerprint: 'fp1',
        traceId: traceIdForRun({ rootId: 'run_1', traceparent: null }),
        sessionId: 'ses_1',
        friction: { unpricedCalls: 0 },
        scores: null,
      },
    })
  })

  test('tokens normalised to the additive contract: reasoning is counted once', () => {
    const [row] = argoRowsForStep(step(), opts)
    // Raw provider usage: output 340 includes 300 reasoning, input 2000 includes 800 cache reads.
    expect(row).toMatchObject({ input_tokens: 1200, output_tokens: 40, cache_read_tokens: 800, reasoning_tokens: 300 })
    // Argo's total: input + output + cache_write + reasoning. Unnormalised it would be 2000 + 340 + 300 = 2640,
    // double-counting the 300 reasoning tokens (and the 800 cached ones as fresh input).
    const total = (row?.input_tokens ?? 0) + (row?.output_tokens ?? 0) + (row?.reasoning_tokens ?? 0)
    expect(total).toBe(1200 + 40 + 300)
  })

  test('a step with several models: one row each, unmodelled usage as the remainder', () => {
    const rows = argoRowsForStep(
      step({
        model: null,
        tokens: { input: 300, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 10 },
        cost: 0.03,
        toolCalls: 1,
        byModel: {
          a: {
            tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            cost: 0.01,
            toolCalls: 0,
            unpricedCalls: 0,
          },
          b: {
            tokens: { input: 150, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 10 },
            cost: 0.02,
            toolCalls: 1,
            unpricedCalls: 0,
          },
        },
      }),
      opts,
    )
    expect(rows.map((r) => [r.source_id, r.input_tokens, r.output_tokens, r.cost_usd])).toEqual([
      ['run_1:ask:a', 100, 20, 0.01],
      ['run_1:ask:b', 150, 20, 0.02],
      ['run_1:ask:unknown', 50, 10, null],
    ])
  })

  test('unpriced usage: cost null, cost_source none', () => {
    const [row] = argoRowsForStep(
      step({
        cost: null,
        unpricedCalls: 1,
        byModel: {
          m: {
            tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            cost: null,
            toolCalls: 0,
            unpricedCalls: 1,
          },
        },
        tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      }),
      opts,
    )
    expect(row).toMatchObject({ cost_usd: null, cost_source: 'none', raw: { unpricedCalls: 1 } })
  })

  test('outcome: failed step or invalid run output is an error; no usage, no row', () => {
    expect(argoRowsForStep(step({ status: 'failed' }), opts)[0]?.outcome).toBe('error')
    expect(argoRowsForStep(step({}, { status: 'failed', errorKind: 'invalid_output' }), opts)[0]?.outcome).toBe('error')
    expect(
      argoRowsForStep(
        step({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: null, byModel: null }),
        opts,
      ),
    ).toEqual([])
  })

  test('a caller traceparent is the trace id; a run without a purpose cannot be projected', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    expect(argoRowsForStep(step({}, { traceparent }), opts)[0]?.raw).toMatchObject({
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
    expect(() => argoRowsForStep(step({}, { purpose: '' }), opts)).toThrow(/purpose/)
  })

  test('cache writes have their own bucket: out of input, into cache_write_tokens, counted once', () => {
    const tokens = { input: 1000, output: 50, cacheRead: 600, cacheWrite: 300, reasoning: 20 }
    expect(additiveTokens(tokens)).toEqual({
      input_tokens: 100,
      output_tokens: 30,
      cache_read_tokens: 600,
      cache_write_tokens: 300,
      reasoning_tokens: 20,
    })
  })

  test('remainder: clamped per bucket, dropped without positive tokens, cost tolerance relative', () => {
    const big = 123456.789
    const rows = argoRowsForStep(
      step({
        model: null,
        // The split over-reports output (a stored sum that disagrees): the remainder clamps at 0, never negative.
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: big,
        byModel: {
          a: {
            tokens: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            cost: big - 1e-7, // float noise relative to the total, not a real remainder
            toolCalls: 0,
            unpricedCalls: 0,
          },
        },
      }),
      opts,
    )
    expect(rows.map((r) => r.source_id)).toEqual(['run_1:ask:a'])
    const withRest = argoRowsForStep(
      step({
        model: null,
        tokens: { input: 150, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0.03,
        byModel: {
          a: {
            tokens: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            cost: 0.01,
            toolCalls: 0,
            unpricedCalls: 0,
          },
        },
      }),
      opts,
    )
    expect(withRest.map((r) => [r.source_id, r.input_tokens, r.output_tokens])).toEqual([
      ['run_1:ask:a', 100, 12],
      ['run_1:ask:unknown', 50, 0],
    ])
    expect(withRest[1]?.cost_usd).toBeCloseTo(0.02, 12)
  })

  test('the http transport refuses a non-https Argo URL unless it is loopback', () => {
    expect(() => httpArgoTransport({ url: 'http://argo.example.com/api', token: 't' })).toThrow(/https/)
    expect(() => httpArgoTransport({ url: 'https://argo.example.com/api', token: 't' })).not.toThrow()
    expect(() => httpArgoTransport({ url: 'http://127.0.0.1:9999/api', token: 't' })).not.toThrow()
    expect(() => httpArgoTransport({ url: 'http://localhost:9999/api', token: 't' })).not.toThrow()
  })
})
