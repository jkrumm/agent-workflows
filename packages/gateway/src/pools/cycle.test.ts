import { describe, expect, test } from 'bun:test'

import { cycleOf } from './cycle.ts'

const iso = (cycle: { start: Date; end: Date | null }) => ({
  start: cycle.start.toISOString(),
  end: cycle.end?.toISOString() ?? null,
})

// cycleDay is the credit's expiry day: a cycle runs from the previous expiry to the next one.
describe('cycleOf', () => {
  test("mid-month, after this month's expiry day", () => {
    expect(iso(cycleOf(14, new Date('2026-11-20T10:00:00Z')))).toEqual({
      start: '2026-11-14T00:00:00.000Z',
      end: '2026-12-14T00:00:00.000Z',
    })
  })

  test("mid-month, before this month's expiry day, across a year boundary", () => {
    expect(iso(cycleOf(21, new Date('2026-01-05T10:00:00Z')))).toEqual({
      start: '2025-12-21T00:00:00.000Z',
      end: '2026-01-21T00:00:00.000Z',
    })
  })

  test('day 31 clamps to February in a common year', () => {
    expect(iso(cycleOf(31, new Date('2027-02-15T00:00:00Z')))).toEqual({
      start: '2027-01-31T00:00:00.000Z',
      end: '2027-02-28T00:00:00.000Z',
    })
    expect(iso(cycleOf(31, new Date('2027-03-01T00:00:00Z')))).toEqual({
      start: '2027-02-28T00:00:00.000Z',
      end: '2027-03-31T00:00:00.000Z',
    })
  })

  test('day 31 clamps to February 29 in a leap year', () => {
    expect(iso(cycleOf(31, new Date('2028-02-29T12:00:00Z')))).toEqual({
      start: '2028-02-29T00:00:00.000Z',
      end: '2028-03-31T00:00:00.000Z',
    })
  })

  test('day 1', () => {
    expect(iso(cycleOf(1, new Date('2026-12-31T23:59:59Z')))).toEqual({
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    })
  })

  test('at the expiry instant the new cycle starts; a millisecond before, the old one runs', () => {
    expect(iso(cycleOf(14, new Date('2026-11-14T00:00:00.000Z')))).toEqual({
      start: '2026-11-14T00:00:00.000Z',
      end: '2026-12-14T00:00:00.000Z',
    })
    expect(iso(cycleOf(14, new Date('2026-11-13T23:59:59.999Z')))).toEqual({
      start: '2026-10-14T00:00:00.000Z',
      end: '2026-11-14T00:00:00.000Z',
    })
  })

  test('null (expiry unknown) is a rolling 31-day window with no end', () => {
    expect(iso(cycleOf(null, new Date('2026-11-01T12:00:00Z')))).toEqual({
      start: '2026-10-01T12:00:00.000Z',
      end: null,
    })
  })

  test('an out-of-range day throws', () => {
    expect(() => cycleOf(0, new Date())).toThrow(RangeError)
    expect(() => cycleOf(32, new Date())).toThrow(RangeError)
  })
})
