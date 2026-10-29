import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callerAuth, PLATFORM_CALLER, parseDoorTokens, readDoorTokens } from '../src/process/callers.ts'

const TOKEN = 'hermes-token-0123456789abcdef-0123456789'
const OTHER = 'other-token-0123456789abcdef-01234567890'
const SECRET = 'test-secret-0123456789abcdef-0123456789'

const refusal = (text: string) => {
  try {
    parseDoorTokens(text, 'tokens')
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a refusal')
}

describe('parseDoorTokens', () => {
  test('reads name=token lines; blanks, comments and CRLF are fine', () => {
    const tokens = parseDoorTokens(`# callers\n\nhermes=${TOKEN}\r\nmac-whisper = ${OTHER}\n`, 'tokens')
    expect([...tokens]).toEqual([
      ['hermes', TOKEN],
      ['mac-whisper', OTHER],
    ])
  })

  test('refuses every malformed file naming the line, never a token', () => {
    const cases = [
      [`hermes ${TOKEN}`, 'tokens:1: expected name=token'],
      [`Hermes=${TOKEN}`, 'tokens:1: a caller name'],
      [`agw=${TOKEN}`, 'reserved'],
      [`hermes=${TOKEN}\nhermes=${OTHER}`, 'tokens:2: caller "hermes" is listed twice'],
      ['hermes=short', 'at least 32 characters'],
      [`hermes=${TOKEN}\nmac=${TOKEN}`, 'tokens:2: the token of "mac" is another caller'],
    ] as const
    for (const [text, message] of cases) {
      const error = refusal(text)
      expect(error).toContain(message)
      expect(error).not.toContain(TOKEN)
      expect(error).not.toContain('short')
    }
  })
})

describe('readDoorTokens', () => {
  test('a regular file at 0600 is read; a wider mode, a symlink or no file refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'door-tokens-'))
    try {
      const file = join(dir, 'door-tokens')
      writeFileSync(file, `hermes=${TOKEN}\n`)
      chmodSync(file, 0o600)
      expect(readDoorTokens(file).get('hermes')).toBe(TOKEN)
      chmodSync(file, 0o644)
      expect(() => readDoorTokens(file)).toThrow('mode 0600')
      chmodSync(file, 0o600)
      const link = join(dir, 'link')
      symlinkSync(file, link)
      expect(() => readDoorTokens(link)).toThrow('regular file')
      expect(() => readDoorTokens(join(dir, 'absent'))).toThrow('make deploy creates it')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('callerAuth', () => {
  const auth = callerAuth({ tokens: new Map([['hermes', TOKEN]]), secret: SECRET })

  test('a door token is its caller, the API secret is agw', () => {
    expect(auth(`Bearer ${TOKEN}`)).toBe('hermes')
    expect(auth(`bearer ${SECRET}`)).toBe(PLATFORM_CALLER)
  })

  test('anything else is no caller', () => {
    for (const header of [null, '', 'Bearer', `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
      expect(auth(header)).toBeNull()
    }
  })

  test('an empty bearer never matches an empty secret slot', () => {
    expect(callerAuth({ tokens: new Map(), secret: '' })('Bearer ')).toBeNull()
  })
})
