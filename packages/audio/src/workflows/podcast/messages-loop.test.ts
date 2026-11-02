import { describe, expect, test } from 'bun:test'
import type { ResolvedRoute } from '../../../../routes/src/index.ts'
import type { Usage } from '../../../../runtime/src/index.ts'
import { anthropicReply, iuModelPort, parseAnthropicMessage } from './iu.ts'
import { Llm, ModelError, runToolLoop, type ToolDef, type ToolLoopParams } from './llm.ts'
import type { PodcastRouteId } from './routes.ts'

// The tool loop on the Anthropic Messages wire, end to end: the real `iuModelPort` over a fake `fetch`, the real `Llm`
// and `runToolLoop`. Requests are asserted as they were serialised.

const ENV = { AGW_GATEWAY_URL: 'https://gateway.example.com', AGW_API_SECRET: 'k' }
const ATTRIBUTION = { runId: 'run-1', rootId: 'root-1', workflow: 'podcast', step: 'write', purpose: 'verify' }

async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

type Block = Record<string, unknown>
const THINKING: Block = { type: 'thinking', thinking: 'two plus three', signature: 'sig-abc==' }
const toolUse = (id: string, input: unknown): Block => ({ type: 'tool_use', id, name: 'add', input })

/** A Messages SSE stream for `blocks`, split into deltas the way the API streams them. */
function messageSse(blocks: Block[], stop: string, usage: Record<string, unknown> = {}): string {
  const events: unknown[] = [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
    },
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      const text = String(block.text)
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(0, 3) } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(3) } })
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      })
    } else if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input)
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } })
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(0, 4) },
      })
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(4) },
      })
    } else events.push({ type: 'content_block_start', index, content_block: block })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 20 } })
  events.push({ type: 'message_stop' })
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

const CHAT_DONE = (content: string) =>
  Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  })
const CHAT_CALL = Response.json({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c9', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":1}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
})

interface Seen {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

/** Answers each request with the next scripted response and records it parsed. */
function harness(route: Partial<ResolvedRoute>, responses: Array<() => Response>) {
  const seen: Seen[] = []
  const usages: Usage[] = []
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
    const next = responses.shift()
    if (!next) throw new Error('fake fetch: no scripted response left')
    return next()
  }
  const llm = new Llm(
    iuModelPort({ env: ENV, fetch, backoffMs: 1 }),
    {
      addUsage: (u) => usages.push(u),
      signal: new AbortController().signal,
      progress: () => {},
      attribution: ATTRIBUTION,
    },
    (id: PodcastRouteId) => ({
      id,
      wire: 'anthropic',
      model: 'claude-haiku-5-5',
      effort: 'high',
      rate: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
      ...route,
    }),
  )
  return { llm, seen, usages }
}

const sse = (blocks: Block[], stop: string, usage?: Record<string, unknown>) => () =>
  new Response(messageSse(blocks, stop, usage))

let executed: unknown[] = []
const addTool: ToolDef = {
  name: 'add',
  description: 'Add two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  execute: async (args) => {
    executed.push(args)
    const { a, b } = args as { a: number; b: number }
    return String(a + b)
  },
}
const params = (over: Partial<ToolLoopParams> = {}): ToolLoopParams => ({
  route: 'podcast.write',
  systemPrompt: 'You are a calculator.',
  userContent: 'What is 2+3?',
  tools: [addTool],
  maxCompletionTokens: 40_000,
  stage: 'test',
  ...over,
})

describe('tool loop on the Messages wire', () => {
  test('two rounds: tool_use, tool_result, final text — request bodies as sent', async () => {
    executed = []
    const { llm, seen } = harness({}, [
      sse([THINKING, toolUse('toolu_1', { a: 2, b: 3 })], 'tool_use'),
      sse([{ type: 'text', text: '2 + 3 = 5.' }], 'end_turn'),
    ])
    const result = await runToolLoop(llm, params())
    expect(result).toMatchObject({ content: '2 + 3 = 5.', rounds: 2, calls: [{ tool: 'add', ok: true }] })
    expect(executed).toEqual([{ a: 2, b: 3 }])
    expect(seen).toHaveLength(2)

    expect(seen[0]?.url).toBe('https://gateway.example.com/anthropic/v1/messages')
    const headers = seen[0]?.headers
    expect(headers?.get('authorization')).toBe('Bearer k')
    expect(headers?.get('anthropic-version')).toBe('2023-06-01')
    expect(headers?.get('x-agw-fallback')).toBe('none')
    expect(headers?.get('x-agw-purpose')).toBe('verify')
    expect(headers?.get('x-agw-run-id')).toBe('run-1')

    expect(seen[0]?.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 40_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [
        {
          name: 'add',
          description: 'Add two numbers',
          input_schema: addTool.parameters,
        },
      ],
      system: [{ type: 'text', text: 'You are a calculator.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'What is 2+3?' }],
      stream: true,
    })
    expect(seen[1]?.body.messages).toEqual([
      { role: 'user', content: 'What is 2+3?' },
      { role: 'assistant', content: [THINKING, toolUse('toolu_1', { a: 2, b: 3 })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '5' }] },
    ])
  })

  test('parallel tool calls answer in ONE user turn, ids preserved; effort none sends no thinking; max_tokens has a floor', async () => {
    executed = []
    const { llm, seen } = harness({ effort: 'none' }, [
      sse([toolUse('t1', { a: 1, b: 1 }), toolUse('t2', { a: 2, b: 2 })], 'tool_use'),
      sse([{ type: 'text', text: 'done' }], 'end_turn'),
    ])
    await runToolLoop(llm, params({ maxCompletionTokens: 100 }))
    expect(seen[0]?.body).not.toHaveProperty('thinking')
    expect(seen[0]?.body).not.toHaveProperty('output_config')
    expect(seen[0]?.body.max_tokens).toBe(32_000)
    const turns = seen[1]?.body.messages as Array<{ role: string; content: Block[] }>
    expect(turns).toHaveLength(3)
    expect(turns[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '2' },
        { type: 'tool_result', tool_use_id: 't2', content: '4' },
      ],
    })
  })

  test('thinking and redacted_thinking blocks (signatures intact) go back unchanged, in order', async () => {
    const redacted: Block = { type: 'redacted_thinking', data: 'opaque-bytes' }
    const { llm, seen } = harness({}, [
      sse([THINKING, redacted, { type: 'text', text: 'let me add' }, toolUse('t1', { a: 2, b: 3 })], 'tool_use'),
      sse([{ type: 'text', text: 'ok' }], 'end_turn'),
    ])
    await runToolLoop(llm, params())
    const turns = seen[1]?.body.messages as Array<{ role: string; content: Block[] }>
    expect(turns[1]).toEqual({
      role: 'assistant',
      content: [THINKING, redacted, { type: 'text', text: 'let me add' }, toolUse('t1', { a: 2, b: 3 })],
    })
  })

  test('the prompt prefix is byte-stable: each round is a prefix-extension of the next', async () => {
    const { llm, seen } = harness({}, [
      sse([THINKING, toolUse('t1', { a: 2, b: 3 })], 'tool_use'),
      sse([{ ...THINKING, signature: 'sig-2' }, toolUse('t2', { a: 5, b: 5 })], 'tool_use'),
      sse([{ type: 'text', text: 'ten' }], 'end_turn'),
    ])
    await runToolLoop(llm, params())
    expect(seen).toHaveLength(3)
    // Cache order is tools, system, messages: the first two are identical, the messages extend.
    for (const [a, b] of [
      [0, 1],
      [1, 2],
    ] as const) {
      const [x, y] = [seen[a]?.body, seen[b]?.body]
      expect(JSON.stringify(x?.tools)).toBe(JSON.stringify(y?.tools))
      expect(JSON.stringify(x?.system)).toBe(JSON.stringify(y?.system))
      const earlier = JSON.stringify(x?.messages ?? [])
      const later = JSON.stringify(y?.messages ?? [])
      expect(later.startsWith(earlier.slice(0, -1))).toBe(true)
      expect(later.length).toBeGreaterThan(earlier.length)
    }
  })

  test('usage: cache read/write split, input incl. cache, priced at the route rate, one record per round', async () => {
    const { llm, usages } = harness({}, [
      sse([toolUse('t1', { a: 1, b: 2 })], 'tool_use', {
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 500,
      }),
      sse([{ type: 'text', text: 'three' }], 'end_turn', { input_tokens: 50, cache_read_input_tokens: 2500 }),
    ])
    await runToolLoop(llm, params())
    expect(usages).toHaveLength(2)
    expect(usages[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      tokens: { input: 2600, output: 20, cacheRead: 2000, cacheWrite: 500 },
    })
    // (100*1 + 2000*0.1 + 500*1.25 + 20*5) / 1e6
    expect(usages[0]?.cost).toBeCloseTo((100 + 200 + 625 + 100) / 1e6, 10)
    expect(usages[1]?.tokens).toMatchObject({ input: 2550, cacheRead: 2500, cacheWrite: 0 })
  })

  test('a max_tokens stop is length: the cut tool call is never run, the round is retried at double the budget', async () => {
    executed = []
    const { llm, seen } = harness({}, [
      // The model was cut mid-arguments.
      () =>
        new Response(
          [
            { type: 'message_start', message: { usage: { input_tokens: 10 } } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 't1', name: 'add', input: {} },
            },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a": 2, "b' } },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 99 } },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join(''),
        ),
      sse([toolUse('t2', { a: 2, b: 3 })], 'tool_use'),
      sse([{ type: 'text', text: 'five' }], 'end_turn'),
    ])
    const result = await runToolLoop(llm, params({ maxCompletionTokens: 40_000 }))
    expect(result).toMatchObject({ content: 'five', rounds: 2 })
    expect(executed).toEqual([{ a: 2, b: 3 }])
    expect(seen.map((s) => s.body.max_tokens)).toEqual([40_000, 80_000, 40_000])
  })

  test('a truncated text answer is retried, and still truncated it fails instead of returning half an answer', async () => {
    const cut = sse([{ type: 'text', text: 'half an ans' }], 'max_tokens')
    const { llm, seen } = harness({}, [cut, cut])
    const error = await rejected(runToolLoop(llm, params()))
    expect(error.message).toContain('finish_reason=length')
    expect(seen).toHaveLength(2)
  })

  test('a garbled stream (no stop reason) is retried; a 402 is a balance failure', async () => {
    const cutStream = () =>
      new Response(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })}\n\n`)
    const { llm, seen } = harness({}, [cutStream, sse([{ type: 'text', text: 'ok' }], 'end_turn')])
    expect((await runToolLoop(llm, params())).content).toBe('ok')
    expect(seen).toHaveLength(2)

    const broke = harness({}, [() => new Response('{"error":"credit"}', { status: 402 })])
    const error = await rejected(runToolLoop(broke.llm, params()))
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).balance).toBe(true)
  })

  test('a route on a wire other than iu-openai or anthropic fails loudly by name, before anything is sent', async () => {
    const { llm, seen } = harness({ wire: 'opencode' }, [])
    const error = await rejected(runToolLoop(llm, params()))
    expect(error.message).toContain('opencode wire')
    expect(error.message).toContain('podcast.write')
    expect(seen).toHaveLength(0)
  })
})

describe('balance failure mid-loop: the loop stays on the fallback', () => {
  const withFallback = (fallback: Partial<ResolvedRoute>) => ({
    fallback: { wire: 'iu-openai', model: 'gpt-fallback', effort: 'medium', ...fallback } as never,
  })
  const BALANCE = () => new Response('{"error":{"message":"credit"}}', { status: 402 })

  test('round 2 hits 402: the transcript is re-rendered on chat without thinking blocks, no tool runs twice, round 3 skips the Claude route', async () => {
    executed = []
    const { llm, seen } = harness(withFallback({}), [
      sse([THINKING, { type: 'text', text: 'adding' }, toolUse('toolu_1', { a: 2, b: 3 })], 'tool_use'),
      BALANCE,
      () => CHAT_CALL.clone(),
      () => CHAT_DONE('final'),
    ])
    const result = await runToolLoop(llm, params())
    expect(result.content).toBe('final')
    expect(result.rounds).toBe(3)
    expect(executed).toEqual([
      { a: 2, b: 3 },
      { a: 1, b: 1 },
    ])
    expect(seen.map((s) => s.url.split('/gateway.example.com')[1] ?? s.url)).toEqual(
      [
        '/anthropic/v1/messages',
        '/anthropic/v1/messages',
        '/openai/v1/chat/completions',
        '/openai/v1/chat/completions',
      ].map((u) => u),
    )
    // The fallback request: chat shape, the Claude turn rebuilt from its chat fields, nothing Anthropic-specific.
    expect(seen[2]?.body.messages).toEqual([
      { role: 'system', content: 'You are a calculator.' },
      { role: 'user', content: 'What is 2+3?' },
      {
        role: 'assistant',
        content: 'adding',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '5' },
    ])
    expect(JSON.stringify(seen[2]?.body)).not.toContain('signature')
    // The next round goes straight to the fallback: no second 402, and the chat turn is echoed untouched.
    expect(seen[3]?.body.messages).toHaveLength(6)
  })

  test('onto the GPT-6.1 family: function_call / function_call_output items on /responses', async () => {
    const { llm, seen } = harness(withFallback({ model: 'gpt-6.1-fake' }), [
      sse([THINKING, toolUse('toolu_1', { a: 2, b: 3 })], 'tool_use'),
      BALANCE,
      () =>
        Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'five' }] }],
        }),
    ])
    const result = await runToolLoop(llm, params())
    expect(result.content).toBe('five')
    expect(seen[2]?.url).toBe('https://gateway.example.com/openai/v1/responses')
    expect(seen[2]?.body.instructions).toBe('You are a calculator.')
    expect(seen[2]?.body.input).toEqual([
      { role: 'user', content: 'What is 2+3?' },
      { type: 'function_call', call_id: 'toolu_1', name: 'add', arguments: '{"a":2,"b":3}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: '5' },
    ])
  })

  test('a balance failure on round 1 falls back before any turn exists', async () => {
    const { llm, seen } = harness(withFallback({}), [BALANCE, () => CHAT_DONE('hi')])
    expect((await runToolLoop(llm, params())).content).toBe('hi')
    expect(seen.map((s) => s.url.endsWith('/chat/completions'))).toEqual([false, true])
  })

  test('a balance failure on the fallback itself is thrown, not looped', async () => {
    const { llm, seen } = harness(withFallback({}), [BALANCE, BALANCE])
    expect((await rejected(runToolLoop(llm, params()))).message).toContain('balance')
    expect(seen).toHaveLength(2)
  })
})

describe('parseAnthropicMessage / anthropicReply', () => {
  test('rebuilds thinking (signature), redacted thinking, text and tool_use input from deltas', () => {
    const parsed = parseAnthropicMessage(
      messageSse(
        [THINKING, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'hello' }, toolUse('t', { q: 1 })],
        'tool_use',
        { cost: 0.5 },
      ),
    )
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.value.blocks).toEqual([
      THINKING,
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: 'hello' },
      toolUse('t', { q: 1 }),
    ])
    expect(parsed.value.usage).toMatchObject({ output_tokens: 20, cost: 0.5 })
    const reply = anthropicReply(parsed.value.blocks, parsed.value.stopReason)
    expect(reply.finishReason).toBe('tool_calls')
    expect(reply.message.content).toBe('hello')
    expect(reply.message.tool_calls).toEqual([
      { id: 't', type: 'function', function: { name: 'add', arguments: '{"q":1}' } },
    ])
  })

  test('a plain JSON message from a proxy that ignores stream parses the same; an error envelope is a stream error', () => {
    const plain = parseAnthropicMessage(
      JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3 } }),
    )
    expect(plain.ok && plain.value.blocks).toEqual([{ type: 'text', text: 'hi' }])
    const error = parseAnthropicMessage('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}')
    expect(error.ok && error.value.streamError).toEqual({ type: 'overloaded_error', message: 'busy' })
  })

  test('finish reasons map to chat vocabulary; other stops pass through and are not finished', () => {
    const map = (stop: string) => anthropicReply([{ type: 'text', text: 'x' }], stop).finishReason
    expect([map('end_turn'), map('stop_sequence'), map('tool_use'), map('max_tokens'), map('refusal')]).toEqual([
      'stop',
      'stop',
      'tool_calls',
      'length',
      'refusal',
    ])
    expect(anthropicReply([toolUse('t', {})], 'max_tokens').message.tool_calls).toBeUndefined()
  })

  test('a garbled tool input on a finished stop is unreadable (retried)', () => {
    const body = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'add', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('')
    expect(parseAnthropicMessage(body).ok).toBe(false)
  })
})
