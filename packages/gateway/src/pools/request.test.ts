import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { isClaudeCodeShaped, sessionId } from './request.ts'

const hash = (content: unknown) => createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 32)

describe('sessionId', () => {
  const body = {
    metadata: { user_id: 'user-1' },
    messages: [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: 'second' },
    ],
  }
  const all = {
    'x-agw-session': 'agw-run',
    'x-claude-code-session-id': 'cc-session',
    'x-session-affinity': 'oc-root',
  }

  test('takes the first non-empty source in chain order', () => {
    expect(sessionId(new Headers(all), body)).toBe('agw-run')
    expect(sessionId(new Headers({ ...all, 'x-agw-session': '' }), body)).toBe('cc-session')
    expect(sessionId(new Headers({ 'x-session-affinity': 'oc-root' }), body)).toBe('oc-root')
    expect(sessionId(new Headers(), body)).toBe('user-1')
    expect(sessionId(new Headers(), { ...body, metadata: { user_id: '  ' } })).toBe(
      hash([{ type: 'text', text: 'first' }]),
    )
  })

  test('the hash is of the first user message only, 32 hex chars', () => {
    const id = sessionId(new Headers(), {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'x' },
      ],
    })
    expect(id).toBe(hash('hello'))
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('null without a user message', () => {
    expect(sessionId(new Headers(), { messages: [{ role: 'assistant', content: 'hi' }] })).toBeNull()
    expect(sessionId(new Headers(), {})).toBeNull()
    expect(sessionId(new Headers(), null)).toBeNull()
  })
})

describe('isClaudeCodeShaped', () => {
  const plain = { system: 'You are a helpful assistant.', messages: [] }

  test('a plain request is not', () => {
    expect(isClaudeCodeShaped(new Headers({ 'anthropic-beta': 'prompt-caching-2024-07-31' }), plain)).toBe(false)
  })

  test('an anthropic-beta token starting claude-code-', () => {
    const headers = new Headers({ 'anthropic-beta': 'prompt-caching-2024-07-31, claude-code-20250219' })
    expect(isClaudeCodeShaped(headers, plain)).toBe(true)
  })

  test('a string system starting You are Claude Code', () => {
    expect(isClaudeCodeShaped(new Headers(), { system: "You are Claude Code, Anthropic's official CLI" })).toBe(true)
  })

  test('the first system block starting You are Claude Code; a later block does not count', () => {
    expect(isClaudeCodeShaped(new Headers(), { system: [{ type: 'text', text: 'You are Claude Code.' }] })).toBe(true)
    expect(
      isClaudeCodeShaped(new Headers(), {
        system: [
          { type: 'text', text: 'Other.' },
          { type: 'text', text: 'You are Claude Code.' },
        ],
      }),
    ).toBe(false)
  })

  test('a claude-cli user-agent', () => {
    expect(isClaudeCodeShaped(new Headers({ 'user-agent': 'claude-cli/2.1.0 (external, cli)' }), plain)).toBe(true)
    expect(isClaudeCodeShaped(new Headers({ 'user-agent': 'opencode/1.0' }), plain)).toBe(false)
  })

  test('x-app: cli', () => {
    expect(isClaudeCodeShaped(new Headers({ 'x-app': 'cli' }), plain)).toBe(true)
    expect(isClaudeCodeShaped(new Headers({ 'x-app': 'web' }), plain)).toBe(false)
  })
})
