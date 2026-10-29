import { describe, expect, test } from 'bun:test'
import { argoRowsForStep, callerOf, type OutboxStep } from '../src/argo.ts'

const startedAt = new Date('2026-10-29T10:00:00.000Z')
const opts = { machine: 'test-machine', now: new Date('2026-10-29T11:00:00.000Z') }

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
  const [row] = argoRowsForStep(stepOf(run), opts)
  return row as NonNullable<typeof row>
}

describe('argo rows carry the run’s caller and project', () => {
  test('a Claude Code session in a repo: project is the repo, raw.caller the session kind', () => {
    const row = rowOf({ caller: 'claude-code', project: 'some-repo', workspace: 'private' })
    expect(row).toMatchObject({ project: 'some-repo', workspace: 'private', raw: { caller: 'claude-code' } })
  })

  test('a named door token without a project: the caller is the project', () => {
    expect(rowOf({ caller: 'iris' })).toMatchObject({ project: 'iris', raw: { caller: 'iris' } })
  })

  test('the API secret without a header is caller agw, project agw', () => {
    expect(rowOf({ caller: 'agw' })).toMatchObject({ project: 'agw', raw: { caller: 'agw' } })
  })

  test('no workspace is sent unless the caller declared one, so Argo classifies from the project', () => {
    expect(rowOf({ caller: 'iris' })).not.toHaveProperty('workspace')
    expect(rowOf({ caller: 'agw', project: 'a-repo', workspace: 'work' })).toMatchObject({ workspace: 'work' })
    expect(rowOf({ caller: 'agw', workspace: 'elsewhere' })).not.toHaveProperty('workspace')
  })

  test('a run no door admitted is the host, or the eval harness for eval and drift', () => {
    expect(callerOf({ caller: null, purpose: 'retro' })).toBe('host')
    expect(callerOf({ caller: undefined, purpose: 'prod' })).toBe('host')
    expect(callerOf({ caller: null, purpose: 'eval' })).toBe('eval')
    expect(callerOf({ caller: null, purpose: 'drift' })).toBe('eval')
    expect(callerOf({ caller: 'agw', purpose: 'eval' })).toBe('agw')
    expect(rowOf({ caller: null, purpose: 'retro' })).toMatchObject({ project: 'host', raw: { caller: 'host' } })
  })

  test('a project is not an account: the Max account id never lands in account', () => {
    expect(rowOf({ caller: 'iris' }).account).toBeNull()
  })
})
