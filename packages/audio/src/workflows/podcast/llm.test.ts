import { describe, expect, test } from 'bun:test'
import type { ResolvedRoute } from '../../../../routes/src/index.ts'
import type { Usage } from '../../../../runtime/src/index.ts'
import {
  callAndParse,
  type ChatCall,
  type ChatReply,
  Llm,
  ModelError,
  type ModelPort,
  type OnWireUsage,
  type RoundCall,
  type RoundReply,
  runToolLoop,
  type ToolDef,
  type ToolLoopParams,
  usesResponsesApi,
  type WireMessage,
  type WireUsage,
  writerBudget,
} from './llm.ts'
import { type PodcastRouteId, resolvePodcastRoute } from './routes.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

type Step<R> = R | Error | ((call: never) => R)

const USAGE: WireUsage = {
  model: 'fake-model',
  tokens: { input: 10, output: 5, cacheRead: 0, reasoning: 0 },
  cost: 0.01,
}

/** A scripted ModelPort. `round` snapshots its call, since the loop keeps appending to the same message array. */
class FakePort implements ModelPort {
  readonly chats: ChatCall[] = []
  readonly rounds: RoundCall[] = []
  usage: WireUsage | null = USAGE
  constructor(
    private readonly chatSteps: Array<Step<ChatReply>> = [],
    private readonly roundSteps: Array<Step<RoundReply>> = [],
  ) {}

  async chat(call: ChatCall, signal: AbortSignal, onUsage: OnWireUsage, onSent: () => void): Promise<ChatReply> {
    if (!signal.aborted) onSent()
    this.chats.push(structuredClone(call))
    const step = this.chatSteps.shift()
    if (!step) throw new Error('FakePort: no chat reply scripted')
    if (this.usage) onUsage(this.usage)
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(call as never) : step
  }

  async round(call: RoundCall, signal: AbortSignal, onUsage: OnWireUsage, onSent: () => void): Promise<RoundReply> {
    if (!signal.aborted) onSent()
    this.rounds.push(structuredClone(call))
    const step = this.roundSteps.shift()
    if (!step) throw new Error('FakePort: no round reply scripted')
    if (this.usage) onUsage(this.usage)
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(call as never) : step
  }
}

const route =
  (over: Partial<ResolvedRoute> = {}) =>
  (id: PodcastRouteId) =>
    ({ id, wire: 'iu-openai', model: 'fake-model', effort: 'high', ...over }) as ResolvedRoute

function llmFor(port: ModelPort, resolve: (id: PodcastRouteId) => ResolvedRoute = route(), signal?: AbortSignal) {
  const usages: Usage[] = []
  const llm = new Llm(
    port,
    { addUsage: (u) => usages.push(u), signal: signal ?? new AbortController().signal, progress: () => {} },
    resolve,
  )
  return { llm, usages }
}

const reply = (message: WireMessage, finishReason?: string): RoundReply => ({
  message,
  finishReason: finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
})
const text = (content: string) => reply({ role: 'assistant', content })
const toolCall = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
})
const wantsTool = (name = 'noop', id = 'call_1') =>
  reply({ role: 'assistant', content: null, tool_calls: [toolCall(id, name)] })

const noopTool: ToolDef = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
}

const params = (over: Partial<ToolLoopParams> = {}): ToolLoopParams => ({
  route: 'podcast.research',
  systemPrompt: 'sys',
  userContent: 'user',
  tools: [],
  maxCompletionTokens: 100,
  stage: 'test',
  ...over,
})

describe('runToolLoop', () => {
  test('returns final content when no tool call is made', async () => {
    const port = new FakePort([], [text('all done')])
    const result = await runToolLoop(llmFor(port).llm, params())
    expect(result).toEqual({ content: 'all done', calls: [], rounds: 1 })
    expect(port.rounds[0]?.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ])
  })

  test('echoes the assistant message verbatim, provider fields included, and attaches tool results by tool_call_id in order', async () => {
    const assistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_1', 'toolA', { x: 1 }), toolCall('call_2', 'toolB', { y: 2 })],
      extra_content: { google: { thought_signature: 'opaque-signature-blob' } },
    }
    const port = new FakePort([], [reply(assistantMessage), text('final answer')])
    const seen: unknown[] = []
    const tool = (name: string, result: string): ToolDef => ({
      name,
      description: name,
      parameters: {},
      execute: async (args) => {
        seen.push([name, args])
        return result
      },
    })

    const result = await runToolLoop(
      llmFor(port).llm,
      params({ tools: [tool('toolA', 'result-a'), tool('toolB', 'result-b')] }),
    )

    expect(result.content).toBe('final answer')
    expect(seen).toEqual([
      ['toolA', { x: 1 }],
      ['toolB', { y: 2 }],
    ])
    expect(result.calls.map((c) => c.tool)).toEqual(['toolA', 'toolB'])
    expect(result.calls.every((c) => c.ok)).toBe(true)

    const second = port.rounds[1]?.messages ?? []
    expect(second.find((m) => m.role === 'assistant')).toEqual(assistantMessage)
    expect(second.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'result-a' },
      { role: 'tool', tool_call_id: 'call_2', content: 'result-b' },
    ])
    // The head is never rewritten: system, user, then the echoed message.
    expect(second.slice(0, 2)).toEqual(port.rounds[0]?.messages ?? [])
  })

  test('hands the tool schemas (without execute) to every round', async () => {
    const port = new FakePort([], [text('x')])
    await runToolLoop(llmFor(port).llm, params({ tools: [noopTool] }))
    expect(port.rounds[0]?.tools).toEqual([
      { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } },
    ])
  })

  test('a throwing tool yields an error-string tool message and the loop continues', async () => {
    const port = new FakePort([], [wantsTool('boom'), text('recovered')])
    const boom: ToolDef = {
      name: 'boom',
      description: 'throws',
      parameters: {},
      execute: async () => {
        throw new Error('kaboom')
      },
    }
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [boom] }))
    expect(result.content).toBe('recovered')
    expect(result.calls).toEqual([{ tool: 'boom', args: {}, ok: false, ms: expect.any(Number) }])
    expect(port.rounds[1]?.messages.find((m) => m.role === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'error: kaboom',
    })
  })

  test('an unparsable arguments string produces an error tool result without crashing the loop', async () => {
    const bad = reply({ role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'noop', '{not json')] })
    const port = new FakePort([], [bad, text('done')])
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [noopTool] }))
    expect(result.content).toBe('done')
    expect(result.calls[0]?.ok).toBe(false)
    const toolMessage = port.rounds[1]?.messages.find((m) => m.role === 'tool')
    expect(String(toolMessage?.content)).toContain('invalid arguments JSON')
  })

  test('an unknown tool name is an error result, not a crash', async () => {
    const port = new FakePort([], [wantsTool('missing'), text('done')])
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [noopTool] }))
    expect(result.calls).toEqual([{ tool: 'missing', args: '{}', ok: false, ms: 0 }])
    expect(port.rounds[1]?.messages.find((m) => m.role === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'error: unknown tool "missing"',
    })
  })

  test('is not force-concluded after many rounds — it keeps going until the model stops calling tools', async () => {
    const wanting = 15
    const port = new FakePort(
      [],
      [...Array.from({ length: wanting }, () => wantsTool()), text('final after many rounds')],
    )
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [noopTool] }))
    expect(result.content).toBe('final after many rounds')
    expect(result.rounds).toBe(wanting + 1)
    expect(port.rounds).toHaveLength(wanting + 1)
    // No forced "conclude now" message is ever injected.
    for (const call of port.rounds) {
      expect(call.messages.some((m) => typeof m.content === 'string' && /conclude/i.test(m.content))).toBe(false)
    }
  })

  test('shouldStop ends the loop right after the round whose tool results delivered the work', async () => {
    const port = new FakePort([], [wantsTool('submit'), text('never asked for')])
    let submitted = false
    const submit: ToolDef = {
      name: 'submit',
      description: 'deliver',
      parameters: {},
      execute: async () => {
        submitted = true
        return 'accepted'
      },
    }
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [submit], shouldStop: () => submitted }))
    expect(result).toMatchObject({ content: '', rounds: 1, calls: [{ tool: 'submit', ok: true }] })
    expect(port.rounds).toHaveLength(1)
  })

  test('retries a terminal round with doubled budget when content is empty (finish_reason=length), then succeeds', async () => {
    const port = new FakePort(
      [],
      [reply({ role: 'assistant', content: '' }, 'length'), text('recovered after doubled budget')],
    )
    const result = await runToolLoop(llmFor(port).llm, params())
    expect(result.content).toBe('recovered after doubled budget')
    expect(port.rounds.map((r) => r.maxTokens)).toEqual([100, 200])
    expect(result.rounds).toBe(1)
  })

  test('retries a round whose tool_calls arrived with finish_reason=length (arguments may be cut), then proceeds', async () => {
    const cut = reply({ role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'noop')] }, 'length')
    const port = new FakePort([], [cut, wantsTool(), text('final answer')])
    const result = await runToolLoop(llmFor(port).llm, params({ tools: [noopTool] }))
    expect(port.rounds.map((r) => r.maxTokens)).toEqual([100, 200, 100])
    expect(result.content).toBe('final answer')
    expect(result.calls.map((c) => c.tool)).toEqual(['noop'])
  })

  test('throws when the retry is still empty', async () => {
    const empty = reply({ role: 'assistant', content: '' }, 'length')
    const port = new FakePort([], [empty, empty])
    expect((await rejected(runToolLoop(llmFor(port).llm, params()))).message).toMatch(
      /returned empty content.*after retry with doubled budget/,
    )
  })

  test('passes the route model and effort to the round; effort "none" is left out', async () => {
    const withEffort = new FakePort([], [text('done')])
    await runToolLoop(llmFor(withEffort).llm, params())
    expect(withEffort.rounds[0]).toMatchObject({ api: 'chat', model: 'fake-model', effort: 'high' })

    const without = new FakePort([], [text('done')])
    await runToolLoop(llmFor(without, route({ effort: 'none' })).llm, params())
    expect(without.rounds[0]).not.toHaveProperty('effort')
  })

  test('a failed model call rejects the loop', async () => {
    const port = new FakePort([], [new ModelError('iu-openai request failed (500): boom')])
    expect((await rejected(runToolLoop(llmFor(port).llm, params()))).message).toContain('request failed (500)')
  })

  describe('responses API', () => {
    const responsesRoute = route({ model: 'gpt-6.1-fake' })
    const callOutput = [
      { id: 'fc_1', type: 'function_call', arguments: '{"a":2,"b":3}', call_id: 'call_1', name: 'add' },
    ]
    const callReply: RoundReply = {
      message: { role: 'assistant', content: '', tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
      finishReason: 'stop',
      raw: callOutput,
    }
    const finalReply: RoundReply = {
      message: { role: 'assistant', content: '2 + 3 = 5.' },
      finishReason: 'stop',
      raw: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '2 + 3 = 5.' }] as never,
        },
      ],
    }
    const addTool: ToolDef = {
      name: 'add',
      description: 'add',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => String((args as { a: number; b: number }).a + (args as { a: number; b: number }).b),
    }

    test('the GPT-6.1 family runs on the responses API, everything else on chat', () => {
      expect(usesResponsesApi('gpt-6.1-fake')).toBe(true)
      expect(usesResponsesApi('fake-model')).toBe(false)
    })

    test('echoes the output items and answers with function_call_output items keyed by call_id', async () => {
      const port = new FakePort([], [callReply, finalReply])
      const result = await runToolLoop(
        llmFor(port, responsesRoute).llm,
        params({ tools: [addTool], userContent: '2+3?' }),
      )
      expect(result.content).toBe('2 + 3 = 5.')
      expect(result.rounds).toBe(2)
      expect(result.calls).toMatchObject([{ tool: 'add', ok: true }])
      expect(port.rounds[0]?.api).toBe('responses')
      expect(port.rounds[0]?.model).toBe('gpt-6.1-fake')
      const second = port.rounds[1]?.messages ?? []
      expect(second[2]).toEqual(callOutput[0])
      expect(second[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '5' })
      expect(second.some((m) => m.role === 'tool')).toBe(false)
    })

    test('an incomplete reply cut at the token budget retries with a doubled budget', async () => {
      const cut: RoundReply = { message: { role: 'assistant', content: '' }, finishReason: 'length', raw: [] }
      const port = new FakePort([], [cut, finalReply])
      const result = await runToolLoop(llmFor(port, responsesRoute).llm, params({ maxCompletionTokens: 500 }))
      expect(result.content).toBe('2 + 3 = 5.')
      expect(port.rounds.map((r) => r.maxTokens)).toEqual([500, 1000])
    })
  })
})

describe('Llm usage', () => {
  test('every round is reported once with the model and tokens, priced by the provider cost when given', async () => {
    const port = new FakePort([], [wantsTool(), wantsTool(), text('done')])
    const { llm, usages } = llmFor(port)
    await runToolLoop(llm, params({ tools: [noopTool] }))
    expect(usages).toHaveLength(3)
    expect(usages[0]).toMatchObject({ model: 'fake-model', tokens: USAGE.tokens, cost: 0.01, costSource: 'provider' })
  })

  test('a call without provider cost is priced by the route rate, or counted unpriced when the route has none', async () => {
    const noCost = { ...USAGE, cost: null }
    const rated = new FakePort([], [text('a')])
    rated.usage = noCost
    const ratedLlm = llmFor(rated, route({ rate: { inputPerM: 1_000_000, outputPerM: 2_000_000 } }))
    await runToolLoop(ratedLlm.llm, params())
    expect(ratedLlm.usages[0]).toMatchObject({ cost: 20, costSource: 'rate' })

    const unrated = new FakePort([], [text('a')])
    unrated.usage = noCost
    const unratedLlm = llmFor(unrated)
    await runToolLoop(unratedLlm.llm, params())
    expect(unratedLlm.usages[0]).toMatchObject({ cost: null, costSource: 'unknown' })
  })

  test('a call that came back without usage is reported unpriced, never priced at $0 by the route rate', async () => {
    const port = new FakePort([{ text: 'x', stop: 'complete' }])
    port.usage = null
    const { llm, usages } = llmFor(port, route({ rate: { inputPerM: 1, outputPerM: 2 } }))
    await llm.call({
      route: 'podcast.editorial',
      systemPrompt: 's',
      userContent: 'u',
      maxCompletionTokens: 10,
      stage: 't',
    })
    expect(usages).toEqual([
      {
        model: 'fake-model',
        tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
        cost: null,
        costSource: 'unknown',
      },
    ])
  })

  test('a call aborted before its request left records nothing (nothing sent cannot have billed)', async () => {
    const abort = new AbortController()
    const port = new FakePort([new ModelError('cancelled')])
    port.usage = null
    const { llm, usages } = llmFor(port, route(), abort.signal)
    abort.abort()
    expect(
      (
        await rejected(
          llm.call({
            route: 'podcast.editorial',
            systemPrompt: 's',
            userContent: 'u',
            maxCompletionTokens: 10,
            stage: 't',
          }),
        )
      ).message,
    ).toContain('cancelled')
    expect(usages).toEqual([])
    expect(llm.aborted).toBe(true)
  })

  test('Anthropic cache writes are priced through the route rate', async () => {
    const port = new FakePort([{ text: 'x', stop: 'complete' }])
    port.usage = {
      model: 'fake-model',
      tokens: { input: 1_000_000, output: 0, cacheRead: 200_000, cacheWrite: 300_000, reasoning: 0 },
      cost: null,
    }
    const { llm, usages } = llmFor(
      port,
      route({
        wire: 'iu-anthropic',
        rate: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 2, longPromptTokens: 2_000_000 },
      }),
    )
    await llm.call({ route: 'podcast.write', systemPrompt: 's', userContent: 'u', maxCompletionTokens: 10, stage: 't' })
    // 500k plain input at 1, 200k read at 0.1, 300k written at 2.
    expect(usages[0]?.cost).toBeCloseTo(0.5 + 0.02 + 0.6)
  })
})

describe('Llm balance fallback', () => {
  const research = resolvePodcastRoute('podcast.research')

  test('a provider-balance failure moves the call once to the route fallback', async () => {
    expect(research.fallback).toBeDefined()
    const port = new FakePort(
      [],
      [new ModelError('provider balance exhausted (402)', true), text('answered by fallback')],
    )
    const { llm, usages } = llmFor(port, resolvePodcastRoute)
    const result = await runToolLoop(llm, params())
    expect(result.content).toBe('answered by fallback')
    expect(port.rounds.map((r) => r.model)).toEqual([research.model, research.fallback?.model ?? ''])
    expect(usages).toHaveLength(2)
  })

  test('a second balance failure on the fallback is thrown, not looped', async () => {
    const balance = () => new ModelError('provider balance exhausted (402)', true)
    const port = new FakePort([], [balance(), balance()])
    expect((await rejected(runToolLoop(llmFor(port, resolvePodcastRoute).llm, params()))).message).toContain('balance')
    expect(port.rounds).toHaveLength(2)
  })

  test('other failures, and balance failures on a route without fallback, are thrown at once', async () => {
    const other = new FakePort([], [new ModelError('request failed (500)')])
    expect((await rejected(runToolLoop(llmFor(other, resolvePodcastRoute).llm, params()))).message).toContain('500')
    expect(other.rounds).toHaveLength(1)

    // A route without a fallback (`route()` builds none): the balance failure stands.
    const noFallback = new FakePort([], [new ModelError('provider balance exhausted (402)', true)])
    expect((await rejected(runToolLoop(llmFor(noFallback).llm, params()))).message).toContain('balance')
    expect(noFallback.rounds).toHaveLength(1)
  })

  test('single-shot calls fall back too', async () => {
    const port = new FakePort([
      new ModelError('provider balance exhausted (402)', true),
      { text: 'ok', stop: 'complete' },
    ])
    const { llm } = llmFor(port, resolvePodcastRoute)
    const out = await llm.call({
      route: 'podcast.research',
      systemPrompt: 's',
      userContent: 'u',
      maxCompletionTokens: 10,
      stage: 't',
    })
    expect(out).toBe('ok')
    expect(port.chats.map((c) => c.model)).toEqual([research.model, research.fallback?.model ?? ''])
  })
})

describe('Llm.call', () => {
  const call = (llm: Llm, extra: Record<string, unknown> = {}) =>
    llm.call({
      route: 'podcast.editorial',
      systemPrompt: 'sys',
      userContent: 'user',
      maxCompletionTokens: 1000,
      stage: 't',
      ...extra,
    })

  test('returns the text of a complete answer and forwards the call shape', async () => {
    const port = new FakePort([{ text: 'answer', stop: 'complete' }])
    const out = await call(llmFor(port).llm, { cacheableSystemPrefix: 'sys', jsonSchema: { type: 'object' } })
    expect(out).toBe('answer')
    expect(port.chats[0]).toEqual({
      wire: 'iu-openai',
      model: 'fake-model',
      effort: 'high',
      system: 'sys',
      user: 'user',
      maxTokens: 1000,
      cacheablePrefix: 'sys',
      jsonSchema: { type: 'object' },
    })
  })

  test('an empty answer is "" so the caller retries with a larger budget', async () => {
    const port = new FakePort([{ text: '  \n', stop: 'complete' }])
    expect(await call(llmFor(port).llm)).toBe('')
  })

  test('a length stop is returned as-is on the OpenAI wire unless retryOnTruncation is set', async () => {
    const lenient = new FakePort([{ text: 'partial', stop: 'length' }])
    expect(await call(llmFor(lenient).llm)).toBe('partial')
    const strict = new FakePort([{ text: 'partial', stop: 'length' }])
    expect(await call(llmFor(strict).llm, { retryOnTruncation: true })).toBe('')
  })

  test('the Anthropic wire returns "" on any incomplete stop, never a half-written text', async () => {
    const anthropic = route({ wire: 'iu-anthropic' })
    for (const stop of ['length', 'other'] as const) {
      const port = new FakePort([{ text: 'half a segment', stop, stopDetail: 'refusal' }])
      expect(await call(llmFor(port, anthropic).llm)).toBe('')
    }
    const complete = new FakePort([{ text: 'whole', stop: 'complete' }])
    expect(await call(llmFor(complete, anthropic).llm)).toBe('whole')
  })

  test('the route reaches the transport as wire, model and effort', async () => {
    const port = new FakePort([{ text: 'x', stop: 'complete' }])
    await call(llmFor(port, route({ wire: 'iu-anthropic', model: 'fake-claude' })).llm)
    expect(port.chats[0]).toMatchObject({ wire: 'iu-anthropic', model: 'fake-claude' })
  })
})

describe('callAndParse', () => {
  test('retries the whole call once when the reply does not parse, sizing the call by attempt', async () => {
    const attempts: number[] = []
    const replies = ['not json', '{"ok":true}']
    const out = await callAndParse(
      't',
      async (attempt) => {
        attempts.push(attempt)
        return replies[attempt - 1] ?? ''
      },
      (raw) => JSON.parse(raw) as { ok: boolean },
    )
    expect(out).toEqual({ ok: true })
    expect(attempts).toEqual([1, 2])
  })

  test('throws the last parse error after the final attempt', async () => {
    let calls = 0
    expect(
      (
        await rejected(
          callAndParse(
            't',
            async () => {
              calls++
              return `bad ${calls}`
            },
            (raw) => {
              throw new Error(`cannot parse ${raw}`)
            },
            3,
          ),
        )
      ).message,
    ).toContain('cannot parse bad 3')
    expect(calls).toBe(3)
  })

  test('a failing call is not retried', async () => {
    let calls = 0
    expect(
      (
        await rejected(
          callAndParse(
            't',
            async () => {
              calls++
              throw new ModelError('down')
            },
            (raw) => raw,
          ),
        )
      ).message,
    ).toContain('down')
    expect(calls).toBe(1)
  })
})

describe('writerBudget', () => {
  test('adds reasoning headroom, doubles on the retry and caps at 64k', () => {
    expect(writerBudget(4000, 1)).toBe(20_000)
    expect(writerBudget(4000, 2)).toBe(40_000)
    expect(writerBudget(30_000, 2)).toBe(64_000)
  })
})
