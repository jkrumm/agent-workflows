import { describe, expect, test } from 'bun:test'
import { OWNER_LIMIT_REFUSAL, RATE_LIMIT_REFUSAL, TIER_CAP_REFUSAL } from '../test/support.ts'
import { isSpendLimitFailure, nextMonthStart } from './spend-limit.ts'

const text = (body: unknown): string => JSON.stringify(body)

describe('isSpendLimitFailure', () => {
  test('the documented 400 of an owner-set limit, and its workspace form', () => {
    expect(isSpendLimitFailure({ status: 400, text: text(OWNER_LIMIT_REFUSAL) })).toBe(true)
    const workspace = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits.' },
    }
    expect(isSpendLimitFailure({ status: 400, text: text(workspace) })).toBe(true)
  })

  test('the documented 429 is told by error_code, never by the status', () => {
    expect(isSpendLimitFailure({ status: 429, text: text(TIER_CAP_REFUSAL) })).toBe(true)
    expect(isSpendLimitFailure({ status: 429, text: text(RATE_LIMIT_REFUSAL) })).toBe(false)
    expect(isSpendLimitFailure({ status: 429, text: 'Too Many Requests' })).toBe(false)
  })

  test('the other 400s, other statuses and the wording on the wrong status are not a spend limit', () => {
    const plain = { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }
    expect(isSpendLimitFailure({ status: 400, text: text(plain) })).toBe(false)
    expect(isSpendLimitFailure({ status: 400, text: 'You have reached your specified API usage limits' })).toBe(false)
    expect(
      isSpendLimitFailure({
        status: 400,
        text: text({ error: { message: 'about "You have reached your specified API usage limits"' } }),
      }),
    ).toBe(false)
    expect(isSpendLimitFailure({ status: 429, text: text(OWNER_LIMIT_REFUSAL) })).toBe(false)
    expect(isSpendLimitFailure({ status: 400, text: text(TIER_CAP_REFUSAL) })).toBe(false)
    expect(isSpendLimitFailure({ status: 503, text: text(TIER_CAP_REFUSAL) })).toBe(false)
  })
})

describe('nextMonthStart', () => {
  test('is 00:00 UTC on the first of the next month, across a year end', () => {
    expect(nextMonthStart(new Date('2026-11-21T12:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(nextMonthStart(new Date('2026-11-30T23:59:59Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(nextMonthStart(new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})
