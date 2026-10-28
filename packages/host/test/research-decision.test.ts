import { describe, expect, test } from 'bun:test'
import { type ArmId, decide, pairedCI, type Row, spend } from '../src/workflows/research/decision.ts'

const QUESTIONS = Array.from({ length: 12 }, (_, i) => ({
  id: `q${i}`,
  depth: (i < 6 ? 'quick' : 'standard') as Row['depth'],
}))

/** Three runs per question; `golden(i)` / `supported(i)` per question index, cost and wall per run. */
function arm(
  id: ArmId,
  o: {
    golden?: (i: number) => number
    supported?: (i: number) => number
    cost: number
    wallMs: number
    failEvery?: number
  },
): Row[] {
  return QUESTIONS.flatMap((q, i) =>
    [0, 1, 2].map((rep) => ({
      arm: id,
      caseId: q.id,
      depth: q.depth,
      ok: !(o.failEvery && (i * 3 + rep) % o.failEvery === 0),
      golden: o.golden?.(i) ?? 1,
      supported: o.supported?.(i) ?? 0.8,
      cost: o.cost,
      wallMs: o.wallMs,
    })),
  )
}

describe('the pre-registered decision rule', () => {
  test('paired CI: identical arms give exactly 0; a uniform drop is its own mean', () => {
    const rows = [
      ...arm('engine', { cost: 1, wallMs: 1 }),
      ...arm('agent-yolo', { cost: 1, wallMs: 1, supported: () => 0.5 }),
    ]
    expect(pairedCI(rows, 'engine', 'engine', 'golden')).toMatchObject({ mean: 0, lo: 0, hi: 0, n: 12 })
    const ci = pairedCI(rows, 'engine', 'agent-yolo', 'supported')
    expect(ci?.mean).toBeCloseTo(-0.3)
    expect(ci?.lo).toBeCloseTo(-0.3)
  })

  test('a failed run counts as golden 0 and supported 0; spend reads standard and deep only', () => {
    const rows = [...arm('engine', { cost: 1, wallMs: 1 }), ...arm('agent-yolo', { cost: 2, wallMs: 5, failEvery: 3 })]
    expect(pairedCI(rows, 'engine', 'agent-yolo', 'golden')?.mean).toBeCloseTo(-1 / 3)
    const quickOnlyCheap = rows.map((r) => (r.arm === 'agent-yolo' && r.depth === 'quick' ? { ...r, cost: 0 } : r))
    expect(spend(quickOnlyCheap, 'agent-yolo')).toEqual({ cost: 2, wallMs: 5 })
  })

  test('an equally good, 50 % cheaper agent wins; yolo stays the profile without a focused CI above 0', () => {
    const rows = [
      ...arm('engine', { cost: 0.1, wallMs: 100_000 }),
      ...arm('agent-yolo', { cost: 0.05, wallMs: 100_000 }),
      ...arm('agent-focused', { cost: 0.04, wallMs: 90_000 }),
      ...arm('pilot-yolo', { cost: 0.2, wallMs: 200_000 }),
      ...arm('pilot-focused', { cost: 0.2, wallMs: 200_000 }),
    ]
    const verdict = decide(rows)
    expect(verdict.profiles).toEqual({ agent: 'agent-yolo', pilot: 'pilot-yolo' })
    expect(verdict.winner).toBe('agent-yolo')
  })

  test('an arm 0.25 worse on supported is not eligible, even when far cheaper', () => {
    const rows = [
      ...arm('engine', { cost: 0.1, wallMs: 100_000 }),
      ...arm('agent-yolo', { cost: 0.01, wallMs: 10_000, supported: () => 0.55 }),
      ...arm('agent-focused', { cost: 0.01, wallMs: 10_000, supported: () => 0.55 }),
      ...arm('pilot-yolo', { cost: 0.5, wallMs: 100_000 }),
      ...arm('pilot-focused', { cost: 0.5, wallMs: 100_000 }),
    ]
    const verdict = decide(rows)
    expect(verdict.quality['agent-yolo']?.eligible).toBe(false)
    expect(verdict.winner).toBe('engine')
  })

  test('focused replaces yolo when it is better on golden with a CI above 0', () => {
    const rows = [
      ...arm('engine', { cost: 0.1, wallMs: 1 }),
      ...arm('agent-yolo', { cost: 0.1, wallMs: 1, golden: (i) => (i % 2 ? 0 : 1) }),
      ...arm('agent-focused', { cost: 0.1, wallMs: 1 }),
      ...arm('pilot-yolo', { cost: 0.1, wallMs: 1 }),
      ...arm('pilot-focused', { cost: 0.1, wallMs: 1 }),
    ]
    expect(decide(rows).profiles.agent).toBe('agent-focused')
  })

  test('a done run left unscored on supported is left out, never counted as 0', () => {
    const rows = [
      ...arm('engine', { cost: 1, wallMs: 1 }),
      ...arm('agent-yolo', { cost: 1, wallMs: 1 }).map((r, i) => (i % 3 === 0 ? { ...r, supported: null } : r)),
    ]
    const ci = pairedCI(rows, 'engine', 'agent-yolo', 'supported')
    expect(ci?.n).toBe(12)
    expect(ci?.mean).toBeCloseTo(0, 12) // the unscored runs pulled nothing towards 0 (counted as 0 it would be -0.27)
    expect(ci?.lo).toBeCloseTo(0, 12)
  })

  test('within 20 % on cost and wall time, the simpler design wins', () => {
    const rows = [
      ...arm('engine', { cost: 0.1, wallMs: 100 }),
      ...arm('agent-yolo', { cost: 0.095, wallMs: 95 }),
      ...arm('agent-focused', { cost: 0.095, wallMs: 95 }),
      ...arm('pilot-yolo', { cost: 0.09, wallMs: 90 }),
      ...arm('pilot-focused', { cost: 0.09, wallMs: 90 }),
    ]
    expect(decide(rows).winner).toBe('agent-yolo')
  })
})

test('the report prints a table per depth and the verdict', async () => {
  const { report } = await import('../src/workflows/research/compare.ts')
  const rows = [
    ...arm('engine', { cost: 0.1, wallMs: 100_000 }),
    ...arm('agent-yolo', { cost: 0.05, wallMs: 100_000, failEvery: 9 }),
  ].map((row) => ({
    row,
    partial: false,
    errorKind: row.ok ? null : 'step_failed',
    grounded: 1,
    judgedShare: 1,
    tokens: 10,
    cacheRead: 5,
    toolCalls: 3,
  }))
  const text = report(rows)
  expect(text).toContain('### standard')
  expect(text).toContain('| engine | 36 | 0 | 0 | 1.00 | 0.80 | 1.00 | 1.00 | 0.1000 | 100 | 10 | 0.50 | 3 |')
  expect(text).toContain('### Failed runs')
  expect(text).toContain('**Winner:')
})

test("every capability the gate and the judge call is in the host's registry", async () => {
  const { createCapabilities, createRegistry, iuTransports } = await import('@agent-workflows/capabilities')
  const { CAPABILITY } = await import('../src/workflows/research/gate.ts')
  const { JUDGE_CAPABILITIES } = await import('../src/judge.ts')
  const registry = createRegistry(
    createCapabilities({
      transports: iuTransports({ env: { IU_API_KEY: 'k', IU_BASE_URL: 'http://127.0.0.1:9/anthropic' } }),
      env: {},
    }),
  )
  const ids = new Set<string>(registry.capabilities.map((c) => c.id))
  for (const id of [...Object.values(CAPABILITY), ...JUDGE_CAPABILITIES]) expect(ids.has(id)).toBe(true)
})
