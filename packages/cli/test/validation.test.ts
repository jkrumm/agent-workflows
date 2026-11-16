import { expect, test } from 'bun:test'
import { withFirstIssue } from '../src/host.ts'

// The body the host answers for `agw web read https://example.com --max-chars 400000` (oRPC's input validation).
const OVER_CAP = {
  issues: [
    {
      origin: 'number',
      code: 'too_big',
      maximum: 200000,
      inclusive: true,
      path: ['maxChars'],
      message: 'Too big: expected number to be <=200000',
    },
  ],
}

test('a schema failure names the field, the constraint and the limit in the message', () => {
  const message = withFirstIssue('Input validation failed', OVER_CAP)
  expect(message).toBe('Input validation failed: maxChars: Too big: expected number to be <=200000')
})

test('more issues are counted, a nested path is dotted, a body without issues is left alone', () => {
  const two = {
    issues: [
      { path: [{ key: 'labels' }, 'a'], message: 'Invalid input' },
      { path: ['x'], message: 'no' },
    ],
  }
  expect(withFirstIssue('Input validation failed', two)).toBe(
    'Input validation failed: labels.a: Invalid input (+1 more in details.issues)',
  )
  expect(withFirstIssue('Not found', undefined)).toBe('Not found')
  expect(withFirstIssue('Input validation failed', { issues: [] })).toBe('Input validation failed')
})
