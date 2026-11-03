import { describe, expect, test } from 'bun:test'
import { wilson } from '../src/index.ts'

describe('wilson', () => {
  test('5 of 10 is [0.2366, 0.7634]', () => {
    const w = wilson(5, 10)
    expect(w?.p).toBe(0.5)
    expect(w?.lo).toBeCloseTo(0.2366, 4)
    expect(w?.hi).toBeCloseTo(0.7634, 4)
  })

  test('0 of 10 has a lower bound of 0 and an upper of 0.2775', () => {
    const w = wilson(0, 10)
    expect(w?.lo).toBe(0)
    expect(w?.hi).toBeCloseTo(0.2775, 4)
  })

  test('45 of 50 (the case bar): [0.7864, 0.9565]', () => {
    const w = wilson(45, 50)
    expect(w?.lo).toBeCloseTo(0.7864, 3)
    expect(w?.hi).toBeCloseTo(0.9565, 3)
  })

  test('nothing to estimate without observations', () => {
    expect(wilson(0, 0)).toBeNull()
  })
})
