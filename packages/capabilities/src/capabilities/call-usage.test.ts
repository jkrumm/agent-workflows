import { describe, expect, test } from 'bun:test'
import type { Ctx, Usage } from '../context.ts'
import { trackUsage } from './call-usage.ts'

const tokens = { input: 10, output: 2, cacheRead: 0, reasoning: 0 }
const call = (cost: number | null): Usage => ({
  model: 'm',
  tokens,
  cost,
  costSource: cost === null ? 'unknown' : 'rate',
})

function tracked() {
  const forwarded: Usage[] = []
  const ctx: Ctx = { signal: new AbortController().signal, addUsage: (u) => forwarded.push(u) }
  return { ...trackUsage(ctx), forwarded }
}

describe('trackUsage total', () => {
  test('no billed call is free: costUsd 0', () => {
    expect(tracked().total().costUsd).toBe(0)
  })

  test('priced calls sum; any unpriced call makes the cost unknown, never a partial sum', () => {
    const priced = tracked()
    priced.ctx.addUsage(call(0.25))
    priced.ctx.addUsage(call(0.5))
    expect(priced.total().costUsd).toBeCloseTo(0.75, 12)
    expect(priced.forwarded).toHaveLength(2)

    const mixed = tracked()
    mixed.ctx.addUsage(call(0.25))
    mixed.ctx.addUsage(call(null))
    expect(mixed.total().costUsd).toBeNull()
  })
})
