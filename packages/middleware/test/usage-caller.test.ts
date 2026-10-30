import { describe, expect, test } from 'bun:test'
import { callerOf, type OutboxStep, usageRowsForStep } from '../src/usage.ts'

const startedAt = new Date('2026-10-29T10:00:00.000Z')
const opts = { machine: 'test-machine' }

function stepOf(run: Partial<OutboxStep['run']>): OutboxStep {
  const tokens = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    runId: 'run_1',
    stepId: 'ask',
    status: 'done',
    model: 'm',
    tokens,
    cost: 0.001,
    toolCalls: 0,
    unpricedCalls: 0,
    byModel: null,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1000),
    sessionId: null,
    run: {
      workflowId: 'llm.title',
      rootId: 'run_1',
      purpose: 'prod',
      iuKey: 'personal',
      traceparent: null,
      traceId: null,
      fingerprint: null,
      friction: null,
      status: 'done',
      errorKind: null,
      wallMs: 1000,
      ...run,
    },
  }
}

const rowOf = (run: Partial<OutboxStep['run']>) => {
  const [row] = usageRowsForStep(stepOf(run), opts)
  return row as NonNullable<typeof row>
}

describe('usage rows carry the run’s caller and project', () => {
  test('a Claude Code session in a repo: project_raw and repo are the repo, the caller rides in lane_detail and raw', () => {
    const row = rowOf({ caller: 'claude-code', project: 'some-repo', workspace: 'private' })
    expect(row).toMatchObject({
      project_raw: 'some-repo',
      repo: 'some-repo',
      workspace: 'private',
      lane_detail: { caller: 'claude-code' },
      raw: { caller: 'claude-code' },
    })
  })

  test('a named door token without a project: no project, the caller is still named', () => {
    expect(rowOf({ caller: 'iris' })).toMatchObject({
      project_raw: null,
      repo: null,
      lane_detail: { caller: 'iris' },
      raw: { caller: 'iris' },
    })
  })

  test('workspace is null unless the caller declared one', () => {
    expect(rowOf({ caller: 'iris' }).workspace).toBeNull()
    expect(rowOf({ caller: 'agw', project: 'a-repo', workspace: 'work' })).toMatchObject({
      workspace: 'work',
      repo: null,
    })
    expect(rowOf({ caller: 'agw', workspace: 'elsewhere' }).workspace).toBeNull()
  })

  test('a run no door admitted is the host, or the eval harness for eval and drift', () => {
    expect(callerOf({ caller: null, purpose: 'retro' })).toBe('host')
    expect(callerOf({ caller: undefined, purpose: 'prod' })).toBe('host')
    expect(callerOf({ caller: null, purpose: 'eval' })).toBe('eval')
    expect(callerOf({ caller: null, purpose: 'drift' })).toBe('eval')
    expect(callerOf({ caller: 'agw', purpose: 'eval' })).toBe('agw')
    expect(rowOf({ caller: null, purpose: 'retro' })).toMatchObject({
      lane_detail: { caller: 'host' },
      raw: { caller: 'host' },
    })
  })

  test('a project is not an account: no Max account id on an IU API row', () => {
    expect(rowOf({ caller: 'iris' })).not.toHaveProperty('account')
  })
})
