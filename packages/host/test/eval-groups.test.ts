import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CaseResult, summarize } from '../src/workflows/eval/run.ts'
import { depthSuite } from '../src/workflows/suite.ts'

const scored = (
  caseId: string,
  group: string | undefined,
  costUsd: number | null,
  toolCalls: number | null,
  supported: number,
) =>
  ({
    caseId,
    status: 'scored',
    pass: true,
    scores: { supported },
    costUsd,
    toolCalls,
    ...(group === undefined ? {} : { group }),
  }) satisfies CaseResult

describe('summarize by group', () => {
  test('every figure overall and per group, tool calls and cost summed and averaged', () => {
    const s = summarize([
      scored('a', 'deep', 0.5, 80, 0.5),
      scored('b', 'deep', 0.3, 60, 1),
      scored('c', 'standard', 0.1, 30, 1),
      scored('d', 'standard', null, null, 0),
    ])
    expect(s).toMatchObject({ scored: 4, costUsd: 0.9, toolCalls: 170 })
    expect(s.meanToolCalls).toBeCloseTo(170 / 3, 12)
    expect(Object.keys(s.groups)).toEqual(['deep', 'standard'])
    expect(s.groups.deep).toMatchObject({ scored: 2, means: { supported: 0.75 }, toolCalls: 140, meanToolCalls: 70 })
    expect(s.groups.deep?.meanCostUsd).toBeCloseTo(0.4, 12)
    // A case with no recorded cost or count is out of those figures, never a zero in them.
    expect(s.groups.standard).toMatchObject({
      scored: 2,
      costUsd: 0.1,
      meanCostUsd: 0.1,
      toolCalls: 30,
      means: { supported: 0.5 },
    })
  })

  test('cases without a group fold into the overall only', () => {
    const s = summarize([scored('a', undefined, 0.2, 10, 1)])
    expect(s.groups).toEqual({})
    expect(s).toMatchObject({ scored: 1, costUsd: 0.2, toolCalls: 10 })
    expect(summarize([])).toMatchObject({ costUsd: null, meanCostUsd: null, toolCalls: null, groups: {} })
  })
})

describe('depthSuite', () => {
  test('the group is the depth the case runs at: the arm`s depth wins, a missing depth is standard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-depth-suite-'))
    try {
      const path = join(dir, 'cases.jsonl')
      const line = (id: string, input: object) => JSON.stringify({ id, input, reference: { expect: { any: ['x'] } } })
      writeFileSync(
        path,
        [line('q', { query: 'one fact', depth: 'quick' }), line('s', { query: 'no depth given' })].join('\n') + '\n',
      )
      const [q, s] = depthSuite.read(path)
      expect(q?.group?.({})).toBe('quick')
      expect(q?.group?.({ depth: 'deep' })).toBe('deep')
      expect(s?.group?.({})).toBe('standard')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
