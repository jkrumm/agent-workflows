import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { claudeRate, type ResolvedRoute, resolveModelAlias } from '@agent-workflows/routes'
import type { Attribution, Usage } from './context.ts'
import type { AttemptUsage } from './transports/port.ts'
import { CapabilityError } from './errors.ts'
import fixture from './fixtures/anthropic-1h-cache-write.json'
import { complete } from './llm/model-call.ts'
import { chatStream, type FakeGateway, startFakeGateway } from './testing/index.ts'
import {
  anthropicWire,
  gatewayConfig,
  gatewayHeaders,
  gatewayTransports,
  iuDecision,
  iuOpenai,
} from './transports/index.ts'

let gateway: FakeGateway
beforeEach(() => {
  gateway = startFakeGateway()
})
afterEach(() => gateway.stop())

const env = () => ({ AGW_API_SECRET: 'agw-token', AGW_GATEWAY_URL: gateway.url })
const never = () => new AbortController().signal
const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
const attribution: Attribution = {
  runId: 'run-1',
  rootId: 'root-1',
  workflow: 'review',
  step: 'route',
  purpose: 'prod',
  project: 'agent-workflows',
  workspace: 'private',
  traceparent: TRACEPARENT,
}
const ATTRIBUTED = {
  'x-agw-session': 'root-1',
  'x-agw-run-id': 'run-1',
  'x-agw-workflow': 'review',
  'x-agw-step': 'route',
  'x-agw-purpose': 'prod',
  'x-agw-project': 'agent-workflows',
  'x-agw-workspace': 'private',
  traceparent: TRACEPARENT,
}

const notConfigured = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError)
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED' })
    return (error as CapabilityError).message
  }
  throw new Error('expected NOT_CONFIGURED')
}

describe('gatewayConfig', () => {
  test('every base hangs off the origin; a trailing slash is stripped', () => {
    expect(gatewayConfig({ AGW_GATEWAY_URL: 'http://127.0.0.1:7794/', AGW_API_SECRET: ' t ' })).toEqual({
      token: 't',
      anthropicBase: 'http://127.0.0.1:7794/anthropic',
      openaiBase: 'http://127.0.0.1:7794/openai/v1',
      decisionBase: 'http://127.0.0.1:7794/decisions/v1',
      replicateBase: 'http://127.0.0.1:7794/replicate/v1',
    })
  })

  test('both variables are required, there is no default and no IU fallback', () => {
    expect(notConfigured(() => gatewayConfig({ AGW_API_SECRET: 't' }))).toContain('AGW_GATEWAY_URL')
    expect(notConfigured(() => gatewayConfig({ AGW_GATEWAY_URL: 'http://127.0.0.1:7794' }))).toContain('AGW_API_SECRET')
    expect(
      notConfigured(() => gatewayConfig({ IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com/anthropic' })),
    ).toContain('AGW_GATEWAY_URL')
  })

  test('a value that is not an http(s) URL is refused without echoing it', () => {
    for (const value of [
      'secret-host:7794',
      'not a url',
      'ftp://secret-host',
      'http://secret-host/anthropic',
      'http://secret-host/?k=v',
    ]) {
      const message = notConfigured(() => gatewayConfig({ AGW_GATEWAY_URL: value, AGW_API_SECRET: 'secret-token' }))
      expect(message).not.toContain('secret')
    }
  })
})

describe('gatewayHeaders', () => {
  test('maps every field; the session is the root run', () => {
    expect(gatewayHeaders(attribution)).toEqual(ATTRIBUTED)
  })

  test('absent and unsendable values are left out, never a failed call', () => {
    expect(gatewayHeaders(undefined)).toEqual({})
    const { project: _, workspace: __, traceparent: ___, ...bare } = attribution
    expect(gatewayHeaders(bare)).toEqual({
      'x-agw-session': 'root-1',
      'x-agw-run-id': 'run-1',
      'x-agw-workflow': 'review',
      'x-agw-step': 'route',
      'x-agw-purpose': 'prod',
    })
    const bad = gatewayHeaders({ ...attribution, project: 'prüfung', workspace: '', step: 's'.repeat(201) })
    expect(bad).not.toHaveProperty('x-agw-project')
    expect(bad).not.toHaveProperty('x-agw-workspace')
    expect(bad).not.toHaveProperty('x-agw-step')
    expect(gatewayHeaders({ ...attribution, project: 'a\nb' })).not.toHaveProperty('x-agw-project')
    for (const project of [' agw', 'agw ', '   ']) {
      expect(gatewayHeaders({ ...attribution, project })).not.toHaveProperty('x-agw-project')
    }
    expect(gatewayHeaders({ ...attribution, project: 'agent workflows' })['x-agw-project']).toBe('agent workflows')
    expect(gatewayHeaders({ ...attribution, step: 's'.repeat(200) })['x-agw-step']).toHaveLength(200)
  })
})

describe('the wires on the gateway', () => {
  const chat = { model: 'm', prompt: 'p', maxOutputTokens: 10, attribution }
  const headersOf = (index = 0) => Object.fromEntries(gateway.requests[index]?.headers ?? [])

  test('anthropic: bearer token, attribution, and x-agw-fallback none', async () => {
    gateway.on('messages', () => Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }))
    await anthropicWire({ env: env() }).complete(chat, never())
    expect(gateway.requests[0]?.path).toBe('/anthropic/v1/messages')
    expect(headersOf()).toMatchObject({
      ...ATTRIBUTED,
      authorization: 'Bearer agw-token',
      'anthropic-version': '2023-06-01',
      'x-agw-fallback': 'none',
    })
  })

  test('iu-openai: bearer token and attribution, no fallback opt-out', async () => {
    gateway.on('chat', () => chatStream('ok', { prompt_tokens: 1, completion_tokens: 1 }))
    await iuOpenai({ env: env() }).complete(chat, never())
    expect(gateway.requests[0]?.path).toBe('/openai/v1/chat/completions')
    expect(headersOf()).toMatchObject({ ...ATTRIBUTED, authorization: 'Bearer agw-token' })
    expect(headersOf()).not.toHaveProperty('x-agw-fallback')
  })

  test('iu-decision: bearer token and attribution', async () => {
    gateway.on('decide', () => Response.json({ answers: { q: { type: 'noul', noul: 0.9 } } }))
    await iuDecision({ env: env() }).decide(
      { model: 'd', state: 's', questions: { q: { type: 'boolean', instructions: 'i' } }, attribution },
      never(),
    )
    expect(gateway.requests[0]?.path).toBe('/decisions/v1/systemone')
    expect(headersOf()).toMatchObject({ ...ATTRIBUTED, authorization: 'Bearer agw-token' })
    expect(headersOf()).not.toHaveProperty('x-agw-fallback')
  })

  test('a non-ASCII project is dropped and the call still goes through', async () => {
    gateway.on('messages', () => Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }))
    const result = await anthropicWire({ env: env() }).complete(
      { ...chat, attribution: { ...attribution, project: 'Übersetzung' } },
      never(),
    )
    expect(result.text).toBe('ok')
    expect(headersOf()).not.toHaveProperty('x-agw-project')
    expect(headersOf()).toMatchObject({ 'x-agw-run-id': 'run-1' })
  })

  test('without attribution only the token goes: no empty x-agw header', async () => {
    gateway.on('messages', () => Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }))
    await anthropicWire({ env: env() }).complete({ model: 'm', prompt: 'p', maxOutputTokens: 10 }, never())
    const names = Object.keys(headersOf()).filter((name) => name.startsWith('x-agw-') || name === 'traceparent')
    expect(names).toEqual(['x-agw-fallback'])
  })
})

// The fixture's model is the alias: the guard keeps model ids in the route table.
describe('1 h cache writes (a real Haiku 5.5 response through the gateway, 2026-11-02, id and model redacted)', () => {
  const haiku = resolveModelAlias('haiku')
  const rate = claudeRate(haiku)
  const write1hPerM = rate?.cacheWrite1hPerM
  const write5mPerM = rate?.cacheWritePerM
  if (!rate || !write1hPerM || !write5mPerM) throw new Error('the Haiku rate has no cache-write prices')
  const route: ResolvedRoute = { id: 'cheap.title', wire: 'anthropic', model: haiku, rate }
  const { input_tokens: input, output_tokens: output, cache_creation_input_tokens: written } = fixture.usage

  test('the wire reads the 1 h split; model-call prices it at the 1 h rate, the row keeps the total', async () => {
    gateway.on('messages', () => Response.json(fixture))
    const usages: Usage[] = []
    const ctx = { signal: never(), addUsage: (u: Usage) => void usages.push(u), attribution }
    const done = await complete(
      { transports: gatewayTransports({ env: env() }), env: {} },
      { routeId: 'cheap.title', prompt: 'Say ok.', ctx },
      route,
    )
    expect(done.text).toBe('ok')
    expect(fixture.usage.cache_creation.ephemeral_1h_input_tokens).toBe(written)
    const at1h = (input * rate.inputPerM + written * write1hPerM + output * rate.outputPerM) / 1_000_000
    const at5m = (input * rate.inputPerM + written * write5mPerM + output * rate.outputPerM) / 1_000_000
    expect(usages).toHaveLength(1)
    expect(usages[0]?.cost).toBeCloseTo(at1h, 12)
    expect(usages[0]?.cost).not.toBeCloseTo(at5m, 6)
    expect(usages[0]).toMatchObject({
      // The fixture echoes the alias; the usage carries the canonical id.
      model: haiku,
      route: 'cheap.title',
      costSource: 'rate',
      tokens: { input: input + written, output, cacheRead: 0, cacheWrite: written, reasoning: 0 },
    })
    expect(usages[0]?.tokens).not.toHaveProperty('cacheWrite1h')
    expect(headersOf()).toMatchObject({ 'x-agw-run-id': 'run-1' })
  })

  test('without cache_creation_input_tokens the split is the writes, the 1 h part kept', async () => {
    const { cache_creation_input_tokens: _, ...usage } = fixture.usage
    gateway.on('messages', () => Response.json({ ...fixture, usage }))
    const reported: AttemptUsage[] = []
    await anthropicWire({ env: env() }).complete({ model: haiku, prompt: 'p', maxOutputTokens: 8 }, never(), (u) =>
      reported.push(u),
    )
    expect(reported[0]?.tokens).toMatchObject({ cacheWrite: written, cacheWrite1h: written, input: input + written })
  })

  const headersOf = () => Object.fromEntries(gateway.requests[0]?.headers ?? [])
})
