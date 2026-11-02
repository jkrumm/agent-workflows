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

test('route: the single route when every report names the same one, else null; model-less reports count', () => {
  const tokens = { input: 1, output: 1, cacheRead: 0, reasoning: 0 }
  const totals = new UsageTotals()
  expect(totals.route()).toBeNull()
  totals.add({ model: 'm', tokens })
  expect(totals.snapshot().route).toBeNull()
  totals.add({ route: 'r-a', tokens })
  totals.add({ model: 'm', route: 'r-a', tokens })
  expect(totals.snapshot().route).toBe('r-a')
  totals.add({ model: 'm', route: 'r-b', tokens })
  expect(totals.snapshot().route).toBeNull()
})
