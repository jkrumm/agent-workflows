import { expect, test } from 'bun:test'
import type { Usage as CapabilityUsage } from '@agent-workflows/capabilities'
import type { Usage } from '../src/index.ts'
import { UsageTotals } from '../src/usage.ts'

test('a capability usage passes to addUsage as is; unpriced calls are counted, never summed as 0', () => {
  const priced: CapabilityUsage = {
    model: 'm',
    tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 },
    cost: 0.5,
    costSource: 'provider',
  }
  const unpriced: CapabilityUsage = { ...priced, cost: null, costSource: 'unknown' }
  const accepted: Usage[] = [priced, unpriced] // compile-time: capabilities' Usage is assignable
  const totals = new UsageTotals()
  for (const usage of accepted) totals.add(usage)
  const snapshot = totals.snapshot()
  expect(snapshot.cost).toBe(0.5)
  expect(snapshot.unpricedCalls).toBe(1)
  expect(snapshot.byModel.m).toMatchObject({ cost: 0.5, unpricedCalls: 1 })
})
