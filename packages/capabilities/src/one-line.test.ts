import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { messageResponse, type FakeGateway, startFakeGateway } from '@agent-workflows/testing/gateway'
import { clipLine, clipReason, collapseLine, REASON_MAX_CHARS, strictLine } from './capabilities/one-line.ts'
import { createCapabilities } from './capabilities/index.ts'
import { createRegistry } from './registry.ts'
import { gatewayTransports } from './transports/index.ts'

// The one rule behind the factory seats' `reason`: a model's reason is any string, and code brings it to one line of at
// most 240 characters. A long or two-line reason is never a second model call.

describe('the one-line helper', () => {
  test('collapseLine joins lines and runs of spaces', () => {
    expect(collapseLine('a\r\n b\u2028c\t\td   e ')).toBe('a b c d e')
  })

  test('clipLine cuts at a word boundary with an ellipsis, within the cap', () => {
    const out = clipLine(`${'word '.repeat(80)}tail`, 50)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out.endsWith('word…')).toBe(true)
    expect(clipLine('short', 50)).toBe('short')
  })

  test('clipLine cuts a single long word at the cap', () => {
    expect(clipLine('x'.repeat(500), 40)).toBe(`${'x'.repeat(39)}…`)
  })

  test('clipReason is never empty and never over the contract', () => {
    expect(clipReason('  \n ')).toBe('unavailable')
    expect(clipReason(`${'a'.repeat(300)}\nb`)).toHaveLength(REASON_MAX_CHARS)
  })

  test('strictLine still refuses what it is for: a second line or too many characters', () => {
    const line = strictLine(10)
    expect(line.safeParse('ok').success).toBe(true)
    expect(line.safeParse('a\nb').success).toBe(false)
    expect(line.safeParse('x'.repeat(11)).success).toBe(false)
  })
})

describe('a 300-character two-line reason is accepted and clipped, with one model call', () => {
  let iu: FakeGateway
  beforeEach(() => {
    iu = startFakeGateway()
  })
  afterEach(() => iu.stop())

  const registry = () =>
    createRegistry(
      createCapabilities({
        transports: gatewayTransports({ env: { AGW_API_SECRET: 'test-key', AGW_GATEWAY_URL: iu.url }, backoffMs: 0 }),
        env: {},
      }),
    )
  const tokens = { input_tokens: 900, output_tokens: 60 }
  const long = `${'the deciding fact '.repeat(8)}\nsecond line ${'z '.repeat(80)}`
  const noop = { addUsage() {} }

  const expectClipped = (reason: string) => {
    expect(long.length).toBeGreaterThanOrEqual(300)
    expect(reason).toMatch(/^[^\r\n\u2028\u2029]{1,240}$/)
    expect(reason.endsWith('…')).toBe(true)
    expect(iu.requests).toHaveLength(1)
  }

  test('factory.triage', async () => {
    iu.on('messages', () =>
      messageResponse(
        JSON.stringify({
          amend: null,
          settled: null,
          after: [],
          kind: null,
          size: null,
          checkpoint: null,
          reason: long,
        }),
        tokens,
      ),
    )
    const out = await registry().call(
      'factory.triage',
      {
        request: {
          mode: 'settle',
          repo: 'example-app',
          issue: { id: 'issue_20', title: 'Show the coupon', text: '', kind: 'feature', origin: 'you' },
          candidates: [],
        },
      },
      noop,
    )
    expectClipped((out as { reason: string }).reason)
  })

  test('factory.queue, the answer and each edge', async () => {
    iu.on('messages', () =>
      messageResponse(
        JSON.stringify({ edges: [{ issue: 'issue_20', after: 'issue_12', reason: long }], order: [], reason: long }),
        tokens,
      ),
    )
    const out = (await registry().call(
      'factory.queue',
      {
        repo: 'example-app',
        issues: [
          {
            id: 'issue_12',
            title: 'a',
            kind: 'bug',
            state: 'working',
            prio: 0,
            ageMinutes: 1,
            size: null,
            summary: '',
            after: [],
          },
          {
            id: 'issue_20',
            title: 'b',
            kind: 'bug',
            state: 'queued',
            prio: 0,
            ageMinutes: 1,
            size: null,
            summary: '',
            after: [],
          },
        ],
      },
      noop,
    )) as { reason: string; edges: { reason: string }[] }
    expectClipped(out.reason)
    expect(out.edges[0]?.reason).toMatch(/^[^\r\n]{1,240}$/)
  })

  test('factory.steward', async () => {
    iu.on('messages', () =>
      messageResponse(JSON.stringify({ action: 'wake', note: 'carry on', reason: long, decision: null }), tokens),
    )
    const out = await registry().call(
      'factory.steward',
      {
        issue: 'issue_12',
        repo: 'example-app',
        title: 'Fix the checkout total',
        kind: 'bug',
        cause: 'blocked',
        detail: 'waiting',
        stalledMinutes: 45,
        attempt: 1,
        restarts: 0,
        regressions: 0,
        stewardWakes: 0,
        notes: [],
        history: [],
      },
      noop,
    )
    expectClipped((out as { reason: string }).reason)
  })

  test('factory.ask, reason and source', async () => {
    iu.on('messages', () =>
      messageResponse(
        JSON.stringify({ verdict: 'answer', answer: 'make check', reason: long, source: `plan: ${long}` }),
        tokens,
      ),
    )
    const out = (await registry().call(
      'factory.ask',
      {
        question: 'Which command runs the checks?',
        options: ['make check', 'bun test'],
        default: 'make check',
        facts: 'f',
        plan: 'p',
        repo: 'example-app',
      },
      noop,
    )) as { reason: string; source: string }
    expectClipped(out.reason)
    expect(out.source).toMatch(/^[^\r\n]{1,240}$/)
  })

  test('factory.classify', async () => {
    iu.on('messages', () =>
      messageResponse(
        JSON.stringify({
          project: 'argo',
          kind: 'bug',
          class: 'routine',
          size: 's',
          tier: 'sonnet',
          effort: 'medium',
          reason: long,
        }),
        tokens,
      ),
    )
    const out = await registry().call(
      'factory.classify',
      { title: 't', facts: 'f', repo: 'argo', source: 'kuma', projects: ['argo'] },
      noop,
    )
    expectClipped((out as { reason: string }).reason)
  })
})
