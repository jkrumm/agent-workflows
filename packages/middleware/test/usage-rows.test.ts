import { describe, expect, test } from 'bun:test'
import { additiveTokens, type OutboxStep, repoOf, sessionsOf, traceIdForRun, usageRowsForStep } from '../src/index.ts'

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
      iuKey: 'personal',
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

const opts = { machine: 'test-machine' }

const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

describe('usage rows', () => {
  test('one row per step and model, keyed run:step:model, session grain, the lane of a workflow', () => {
    const rows = usageRowsForStep(step(), opts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'agent-workflows',
      source_id: 'run_1:ask:deepseek-v4.1-flash',
      grain: 'session',
      ts: startedAt.toISOString(),
      model_raw: 'deepseek-v4.1-flash',
      model: 'deepseek-v4.1-flash',
      machine: 'test-machine',
      billing: 'api_key',
      api_key: 'personal',
      outcome: 'ok',
      lane: 'agw_workflow',
      lane_detail: { workflow: 'research.report', step: 'ask', caller: 'host', purpose: 'build' },
      run_id: 'run_1',
      duration_ms: 1500,
      cost_reported_usd: 0.0021,
      raw: {
        runId: 'run_1',
        stepId: 'ask',
        purpose: 'build',
        caller: 'host',
        fingerprint: 'fp1',
        traceId: traceIdForRun({ rootId: 'run_1', traceparent: null }),
        sessionId: 'ses_1',
        friction: { unpricedCalls: 0 },
        scores: null,
      },
    })
    // Database-derived columns are never the writer's: no cost, price, session id or ingest time on the row.
    for (const derived of ['cost_usd', 'cost_source', 'price_id', 'session_id', 'ingested_at', 'account'])
      expect(rows[0]).not.toHaveProperty(derived)
  })

  test('the five token kinds, additive: reasoning and cache are each counted once', () => {
    const [row] = usageRowsForStep(
      step({ tokens: { input: 2000, output: 340, cacheRead: 800, cacheWrite: 300, reasoning: 300 }, byModel: null }),
      opts,
    )
    // Raw provider usage: input 2000 includes 800 cache reads and 300 cache writes, output 340 includes 300 reasoning.
    expect(row).toMatchObject({
      input_tokens: 900,
      output_tokens: 40,
      cache_read_tokens: 800,
      cache_write_5m_tokens: 300, // agw cannot split by TTL: all of it is 5-minute
      cache_write_1h_tokens: 0,
      reasoning_tokens: 300,
    })
    expect(additiveTokens({ input: 10, output: 3, cacheRead: 20, cacheWrite: 0, reasoning: 5 })).toMatchObject({
      input_tokens: 0, // clamped, never negative
      output_tokens: 0,
    })
  })

  test('cost_reported_usd is what agw measured; null when it could not price the usage, never 0', () => {
    const unpriced = { tokens: { ...none, input: 5, output: 1 }, cost: null, toolCalls: 0, unpricedCalls: 1 }
    const [row] = usageRowsForStep(
      step({ cost: null, unpricedCalls: 1, tokens: unpriced.tokens, byModel: { m: unpriced } }),
      opts,
    )
    expect(row?.cost_reported_usd).toBeNull()
    expect(row?.raw).toMatchObject({ unpricedCalls: 1 })
    const [free] = usageRowsForStep(step({ cost: 0, byModel: null }), opts)
    expect(free?.cost_reported_usd).toBe(0) // a measured zero stays measured
  })

  test('a step with several models: one row each, unmodelled usage as the "unknown" remainder', () => {
    const rows = usageRowsForStep(
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
    expect(
      rows.map((r) => [r.source_id, r.model_raw, r.model, r.input_tokens, r.output_tokens, r.cost_reported_usd]),
    ).toEqual([
      ['run_1:ask:a', 'a', 'a', 100, 20, 0.01],
      ['run_1:ask:b', 'b', 'b', 150, 20, 0.02],
      ['run_1:ask:unknown', 'unknown', 'unknown', 50, 10, null],
    ])
  })

  test('outcome: failed step or invalid run output is an error; no usage, no row', () => {
    expect(usageRowsForStep(step({ status: 'failed' }), opts)[0]?.outcome).toBe('error')
    expect(usageRowsForStep(step({}, { status: 'failed', errorKind: 'invalid_output' }), opts)[0]?.outcome).toBe(
      'error',
    )
    expect(usageRowsForStep(step({ tokens: none, cost: null, byModel: null }), opts)).toEqual([])
  })

  test('a caller traceparent is the trace id; a run without a purpose cannot be projected', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    expect(usageRowsForStep(step({}, { traceparent }), opts)[0]?.raw).toMatchObject({
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
    expect(() => usageRowsForStep(step({}, { purpose: '' }), opts)).toThrow(/purpose/)
  })

  test('remainder: clamped per bucket, dropped without positive tokens, cost tolerance relative', () => {
    const big = 123456.789
    const rows = usageRowsForStep(
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
    const withRest = usageRowsForStep(
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
    expect(withRest[1]?.cost_reported_usd).toBeCloseTo(0.02, 12)
  })

  test('a cost-only step (zero tokens, a price) keeps its row', () => {
    const rows = usageRowsForStep(step({ model: 'sonar', tokens: none, cost: 0.005, byModel: null }), opts)
    expect(rows.map((r) => [r.source_id, r.input_tokens, r.cost_reported_usd])).toEqual([['run_1:ask:sonar', 0, 0.005]])
  })
})

describe('usage rows: who paid and where', () => {
  test('billing is api_key and api_key the IU key label; never inside raw', () => {
    const [row] = usageRowsForStep(step({}, { iuKey: 'athena-team' }), opts)
    expect(row).toMatchObject({ billing: 'api_key', api_key: 'athena-team' })
    expect(JSON.stringify(row?.raw)).not.toMatch(/iu_?key|athena/i)
  })

  test('repo is the project only when it is a plain SourceRoot slug of a non-work run; project_raw stays verbatim', () => {
    expect(repoOf('argo', 'private')).toBe('argo')
    expect(repoOf('argo', null)).toBe('argo')
    expect(repoOf('basalt-ui', undefined)).toBe('basalt-ui')
    expect(repoOf('argo', 'work')).toBeNull() // under IuRoot the namespace is `iu/<dir>`, not ours to invent
    expect(repoOf('.hermes-wt', 'private')).toBeNull()
    expect(repoOf('a/b', null)).toBeNull()
    expect(repoOf('/Users/x/SourceRoot/argo', null)).toBeNull()
    expect(repoOf('', null)).toBeNull()
    expect(repoOf(null, 'private')).toBeNull()
    const [row] = usageRowsForStep(step({}, { project: 'argo', workspace: 'private' }), opts)
    expect(row).toMatchObject({ repo: 'argo', project_raw: 'argo', workspace: 'private' })
    const [work] = usageRowsForStep(step({}, { project: 'prometheus', workspace: 'work' }), opts)
    expect(work).toMatchObject({ repo: null, project_raw: 'prometheus', workspace: 'work' })
    const [bare] = usageRowsForStep(step(), opts)
    expect(bare).toMatchObject({ repo: null, project_raw: null, workspace: null })
  })

  test('a workspace the caller did not declare is null, never guessed', () => {
    expect(usageRowsForStep(step({}, { workspace: 'elsewhere' }), opts)[0]?.workspace).toBeNull()
  })
})

describe('usage sessions', () => {
  test('one per run: first and last ts over its rows, the earliest row names the model', () => {
    const second = { ...step({ stepId: 'later', startedAt: new Date(startedAt.getTime() + 60_000) }) }
    const rows = [
      ...usageRowsForStep(second, opts),
      ...usageRowsForStep(step({}, { project: 'argo', workspace: 'private' }), opts),
      ...usageRowsForStep(step({ runId: 'run_2' }), opts),
    ]
    const sessions = sessionsOf(rows)
    expect(sessions.map((s) => s.source_session_id)).toEqual(['run_1', 'run_2'])
    expect(sessions[0]).toMatchObject({
      lane_detail: { workflow: 'research.report', caller: 'host', purpose: 'build' },
      api_key: 'personal',
      machine: 'test-machine',
      model: 'deepseek-v4.1-flash',
      first_ts: startedAt.toISOString(),
      last_ts: new Date(startedAt.getTime() + 60_000).toISOString(),
    })
  })
})

describe('usage rows: the after-the-fact score', () => {
  test('raw carries it explicitly: a scorer error is pass null with its kind, never a fail', () => {
    const raw = (scores: unknown) => usageRowsForStep(step({}, { scores }), opts)[0]?.raw as Record<string, unknown>
    expect(raw(null)).toMatchObject({ scores: null, scorePass: null, scoreError: null })
    const verdict = { final: { source: 'drift', scorer: 's1', scores: { ok: 0 }, pass: false } }
    expect(raw(verdict)).toMatchObject({ scores: verdict, scorePass: false, scoreError: null })
    const failed = {
      final: { source: 'drift', scorer: 's1', scores: {}, pass: null, error: 'gave up', errorKind: 'infra' },
    }
    expect(raw(failed)).toMatchObject({ scorePass: null, scoreError: { kind: 'infra', message: 'gave up' } })
    const own = { final: { source: 'regression', scorer: 's1', scores: {}, pass: null, error: 'bug' } }
    expect(raw(own)).toMatchObject({ scorePass: null, scoreError: { kind: 'scorer', message: 'bug' } })
  })
})
