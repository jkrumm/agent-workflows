import { describe, expect, test } from 'bun:test'
import {
  anthropicBody,
  buildSystem,
  iuModelPort,
  parseAnthropicStream,
  parseChatReply,
  parseResponsesReply,
  roundBody,
} from './iu.ts'
import { type ChatCall, ModelError, type RoundCall, type WireMessage, type WireUsage } from './llm.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const ENV = { IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com/anthropic' }
const SIGNAL = new AbortController().signal

const OK_STREAM = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
].join('\n')

describe('parseAnthropicStream', () => {
  test('skips [DONE] and non-JSON data payloads instead of throwing', () => {
    const body = `${OK_STREAM}\ndata: [DONE]\ndata: {not json\ndata: 42\n`
    expect(parseAnthropicStream(body)).toEqual({
      ok: true,
      value: { text: 'Hallo', stopReason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } },
    })
  })

  test('an SSE-shaped body with no valid event is unreadable, not an empty success', () => {
    expect(parseAnthropicStream('data: [DONE]\n')).toEqual({ ok: false, reason: 'SSE body carried no valid events' })
    expect(parseAnthropicStream('data: {not json\ndata: 42\n: keepalive\n')).toEqual({
      ok: false,
      reason: 'SSE body carried no valid events',
    })
  })

  test('thinking blocks are skipped, text blocks concatenated', () => {
    const body = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"A"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"B"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
    ].join('\n')
    expect(parseAnthropicStream(body)).toMatchObject({ ok: true, value: { text: 'AB', stopReason: 'max_tokens' } })
  })

  test('an in-stream error event is carried as a streamError', () => {
    const body = 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'
    expect(parseAnthropicStream(body)).toMatchObject({
      ok: true,
      value: { text: '', streamError: { type: 'overloaded_error', message: 'Overloaded' } },
    })
  })

  test('a plain JSON message body yields its text blocks, stop reason and usage', () => {
    const body = JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'Hi' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 1 },
    })
    expect(parseAnthropicStream(body)).toEqual({
      ok: true,
      value: { text: 'Hi', stopReason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } },
    })
  })

  test('a 200 JSON error envelope surfaces as a streamError, not empty text', () => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    expect(parseAnthropicStream(body)).toEqual({
      ok: true,
      value: {
        text: '',
        stopReason: null,
        usage: {},
        streamError: { type: 'overloaded_error', message: 'Overloaded' },
      },
    })
  })

  test('empty, non-JSON and wrong-shape bodies are explicit failures', () => {
    expect(parseAnthropicStream('')).toEqual({ ok: false, reason: 'empty body' })
    expect(parseAnthropicStream('<html>500</html>')).toEqual({ ok: false, reason: 'body is not a JSON object' })
    expect(parseAnthropicStream('{}')).toEqual({ ok: false, reason: 'JSON body has no content array' })
  })
})

describe('buildSystem — prompt-cache prefix', () => {
  test('splits a matching prefix into a cached block plus the remainder', () => {
    expect(buildSystem('BASE\n\nTAIL', 'BASE')).toEqual([
      { type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\nTAIL' },
    ])
  })

  test('keeps a plain string without a prefix, or when the prefix does not lead the system prompt', () => {
    expect(buildSystem('BASE TAIL')).toBe('BASE TAIL')
    expect(buildSystem('BASE TAIL', 'OTHER')).toBe('BASE TAIL')
  })

  test('a prefix that is the whole prompt yields a single cached block', () => {
    expect(buildSystem('BASE', 'BASE')).toEqual([{ type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } }])
  })
})

describe('anthropicBody', () => {
  const call: ChatCall = { wire: 'iu-anthropic', model: 'fake-model', system: 'sys', user: 'user', maxTokens: 1000 }

  test('without effort there is no thinking and no output_config; the max_tokens floor lifts a small budget', () => {
    const body = anthropicBody(call)
    expect(body).toEqual({
      model: 'fake-model',
      max_tokens: 32_000,
      system: 'sys',
      messages: [{ role: 'user', content: 'user' }],
      stream: true,
    })
  })

  test('a budget above the floor is kept', () => {
    expect(anthropicBody({ ...call, maxTokens: 48_000 }).max_tokens).toBe(48_000)
  })

  test('effort turns on adaptive thinking and output_config.effort', () => {
    const body = anthropicBody({ ...call, effort: 'high' })
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('a JSON schema goes into output_config.format next to the effort', () => {
    const schema = { type: 'object', properties: { turns: { type: 'array' } } }
    const body = anthropicBody({ ...call, effort: 'high', jsonSchema: schema })
    expect(body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } })
    expect(anthropicBody({ ...call, jsonSchema: schema }).output_config).toEqual({
      format: { type: 'json_schema', schema },
    })
  })

  test('a cacheable prefix becomes a cached system block', () => {
    const body = anthropicBody({ ...call, system: 'BASE tail', cacheablePrefix: 'BASE' })
    expect(body.system).toEqual([
      { type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: ' tail' },
    ])
  })
})

describe('roundBody', () => {
  const tool = { name: 'lookup', description: 'Look up', parameters: { type: 'object' } }
  const tools = [tool]
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
  ]
  const base: RoundCall = { api: 'chat', model: 'fake-model', messages, tools, maxTokens: 500 }

  test('chat completions: messages as given, tools wrapped as functions, effort as reasoning_effort', () => {
    expect(roundBody({ ...base, effort: 'high' }) as unknown).toEqual({
      model: 'fake-model',
      messages,
      max_completion_tokens: 500,
      tools: [{ type: 'function', function: tool }],
      reasoning_effort: 'high',
    })
  })

  test('responses: the system message becomes instructions, the rest is input, tools are flat', () => {
    expect(roundBody({ ...base, api: 'responses', effort: 'high' }) as unknown).toEqual({
      model: 'fake-model',
      input: [{ role: 'user', content: 'go' }],
      instructions: 'sys',
      max_output_tokens: 500,
      tools: [{ type: 'function', ...tool }],
      reasoning: { effort: 'high' },
    })
  })

  test('no tools and no effort leave both keys out', () => {
    const body = roundBody({ ...base, tools: [] })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

describe('parseChatReply / parseResponsesReply', () => {
  test('the chat assistant message is kept exactly as sent, provider fields included', () => {
    const message: WireMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      thought_signature: 'opaque',
    }
    const reply = parseChatReply({ choices: [{ message, finish_reason: 'tool_calls' }] })
    expect(reply.message).toBe(message)
    expect(reply.finishReason).toBe('tool_calls')
  })

  test('a chat reply with no choices is an empty assistant message', () => {
    expect(parseChatReply({})).toEqual({ message: { role: 'assistant', content: '' } })
  })

  test('a responses reply joins the text, maps function_call items to tool calls and keeps the raw output', () => {
    const output = [
      { type: 'reasoning', id: 'r1' },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'Hel' },
          { type: 'output_text', text: 'lo' },
        ],
      },
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"q":1}' },
    ]
    const reply = parseResponsesReply({ status: 'completed', output })
    expect(reply.message).toEqual({
      role: 'assistant',
      content: 'Hello',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
    })
    expect(reply.finishReason).toBe('stop')
    expect(reply.raw as unknown).toBe(output)
  })

  test('an incomplete responses reply cut at the token budget reads as length', () => {
    const reply = parseResponsesReply({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    })
    expect(reply.finishReason).toBe('length')
    expect(reply.message.tool_calls).toBeUndefined()
  })
})

describe('iuModelPort', () => {
  const chatCall: ChatCall = { wire: 'iu-openai', model: 'fake-model', system: 's', user: 'u', maxTokens: 100 }
  const anthropicCall: ChatCall = { ...chatCall, wire: 'iu-anthropic' }
  const roundCall: RoundCall = {
    api: 'chat',
    model: 'fake-model',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    maxTokens: 100,
  }

  const sse = (...events: unknown[]) =>
    `${events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n')}\n\ndata: [DONE]\n\n`
  const OPENAI_STREAM = sse(
    { model: 'fake-model', choices: [{ delta: { content: 'Hal' } }] },
    { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
        cost: 0.002,
      },
    },
  )

  interface Seen {
    url: string
    init: RequestInit
  }
  const scripted = (responses: Array<() => Response | Promise<Response>>) => {
    const seen: Seen[] = []
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      const next = responses.shift()
      if (!next) throw new Error('fake fetch: no scripted response left')
      return next()
    }
    return { seen, fetch }
  }
  const port = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
    iuModelPort({ env: ENV, fetch, backoffMs: 1 })
  const usageSink = () => {
    const usages: WireUsage[] = []
    return { usages, onUsage: (u: WireUsage) => usages.push(u) }
  }

  test('chat on the OpenAI wire streams the text, reports usage and posts to the derived openai base', async () => {
    const { seen, fetch } = scripted([() => new Response(OPENAI_STREAM)])
    const { usages, onUsage } = usageSink()
    const reply = await port(fetch).chat({ ...chatCall, effort: 'high' }, SIGNAL, onUsage)
    expect(reply).toEqual({ text: 'Hallo', stop: 'complete' })
    expect(usages).toEqual([
      {
        model: 'fake-model',
        tokens: { input: 12, output: 7, cacheRead: 4, reasoning: 3 },
        cost: 0.002,
      },
    ])
    expect(seen[0]?.url).toBe('https://iu.example.com/openai/v1/chat/completions')
    const body = JSON.parse(String(seen[0]?.init.body))
    expect(body).toMatchObject({
      model: 'fake-model',
      max_completion_tokens: 100,
      reasoning_effort: 'high',
      stream: true,
    })
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBe('Bearer k')
  })

  test('a length stop and an unknown stop are named', async () => {
    const cut = sse({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] })
    const filtered = sse({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] })
    const { fetch } = scripted([() => new Response(cut), () => new Response(filtered)])
    const p = port(fetch)
    expect(await p.chat(chatCall, SIGNAL, () => {})).toEqual({ text: 'x', stop: 'length' })
    expect(await p.chat(chatCall, SIGNAL, () => {})).toEqual({ text: '', stop: 'other', stopDetail: 'content_filter' })
  })

  test('retries on a 503, then succeeds', async () => {
    const { seen, fetch } = scripted([
      () => new Response('overloaded', { status: 503 }),
      () => new Response(OPENAI_STREAM),
    ])
    const reply = await port(fetch).chat(chatCall, SIGNAL, () => {})
    expect(reply.text).toBe('Hallo')
    expect(seen).toHaveLength(2)
  })

  test('gives up after three attempts on a persistent 503', async () => {
    const { seen, fetch } = scripted([
      () => new Response('overloaded', { status: 503 }),
      () => new Response('overloaded', { status: 503 }),
      () => new Response('overloaded', { status: 503 }),
    ])
    expect(await rejected(port(fetch).chat(chatCall, SIGNAL, () => {}))).toBeInstanceOf(ModelError)
    expect(seen).toHaveLength(3)
  })

  test('a relayed invalid_request_error is not retried', async () => {
    const { seen, fetch } = scripted([
      () => new Response('{"error":{"type":"invalid_request_error"}}', { status: 503 }),
    ])
    expect((await rejected(port(fetch).chat(chatCall, SIGNAL, () => {}))).message).toContain('invalid_request_error')
    expect(seen).toHaveLength(1)
  })

  test('a 402 surfaces as a ModelError with balance === true, without a retry', async () => {
    const { seen, fetch } = scripted([() => new Response('Insufficient Balance', { status: 402 })])
    const error = await port(fetch)
      .chat(chatCall, SIGNAL, () => {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).balance).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test('a 503 whose body names the balance is a balance failure too', async () => {
    const { fetch } = scripted([
      () => new Response('Insufficient Balance (PaymentRequired) on provider', { status: 503 }),
    ])
    const error = await port(fetch)
      .chat(chatCall, SIGNAL, () => {})
      .catch((e: unknown) => e)
    expect((error as ModelError).balance).toBe(true)
  })

  test('a stream that ends without a finish reason is retried', async () => {
    const cutOff = sse({ choices: [{ delta: { content: 'Ha' } }] })
    const { seen, fetch } = scripted([() => new Response(cutOff), () => new Response(OPENAI_STREAM)])
    const reply = await port(fetch).chat(chatCall, SIGNAL, () => {})
    expect(reply.text).toBe('Hallo')
    expect(seen).toHaveLength(2)
  })

  test('chat on the Anthropic wire: Messages endpoint, usage input = input + cache read + cache write', async () => {
    const stream = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
      '',
    ].join('\n')
    const { seen, fetch } = scripted([() => new Response(stream)])
    const { usages, onUsage } = usageSink()
    const reply = await port(fetch).chat(anthropicCall, SIGNAL, onUsage)
    expect(reply).toEqual({ text: 'Hallo', stop: 'complete' })
    expect(usages).toEqual([
      {
        model: 'fake-model',
        tokens: { input: 123, output: 9, cacheRead: 100, cacheWrite: 20, reasoning: 0 },
        cost: null,
      },
    ])
    expect(seen[0]?.url).toBe('https://iu.example.com/anthropic/v1/messages')
    expect(new Headers(seen[0]?.init.headers).get('anthropic-version')).toBe('2023-06-01')
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({ max_tokens: 32_000, stream: true })
  })

  test('the Anthropic wire maps max_tokens to length and other stops to other', async () => {
    const stream = (reason: string) =>
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"x"}}\ndata: {"type":"message_delta","delta":{"stop_reason":"${reason}"}}\n`
    const { fetch } = scripted([() => new Response(stream('max_tokens')), () => new Response(stream('refusal'))])
    const p = port(fetch)
    expect(await p.chat(anthropicCall, SIGNAL, () => {})).toEqual({ text: 'x', stop: 'length' })
    expect(await p.chat(anthropicCall, SIGNAL, () => {})).toEqual({ text: 'x', stop: 'other', stopDetail: 'refusal' })
  })

  test('an empty 200 body is retried and the next attempt answers', async () => {
    const { seen, fetch } = scripted([() => new Response(''), () => new Response(OK_STREAM)])
    const reply = await port(fetch).chat(anthropicCall, SIGNAL, () => {})
    expect(reply.text).toBe('Hallo')
    expect(seen).toHaveLength(2)
  })

  test('a persistently unreadable 200 body becomes a ModelError', async () => {
    const junk = () => new Response('data: [DONE]\n')
    const { seen, fetch } = scripted([junk, junk, junk])
    const error = await port(fetch)
      .chat(anthropicCall, SIGNAL, () => {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).message).toContain('unreadable response')
    expect(seen).toHaveLength(3)
  })

  test('an in-stream overloaded_error is retried, an invalid_request_error is not', async () => {
    const overloaded = 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'
    const invalid = 'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}\n'
    const retried = scripted([() => new Response(overloaded), () => new Response(OK_STREAM)])
    expect((await port(retried.fetch).chat(anthropicCall, SIGNAL, () => {})).text).toBe('Hallo')
    expect(retried.seen).toHaveLength(2)

    const fatal = scripted([() => new Response(invalid)])
    expect((await rejected(port(fatal.fetch).chat(anthropicCall, SIGNAL, () => {}))).message).toContain(
      'invalid_request_error: bad',
    )
    expect(fatal.seen).toHaveLength(1)
  })

  test('a 200 JSON error envelope (overloaded) on the Anthropic wire is retried per its type', async () => {
    const envelope = () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    const { seen, fetch } = scripted([envelope, () => new Response(OK_STREAM)])
    expect((await port(fetch).chat(anthropicCall, SIGNAL, () => {})).text).toBe('Hallo')
    expect(seen).toHaveLength(2)
  })

  test('a plain JSON message body from a proxy that ignores `stream` is read on the Anthropic wire', async () => {
    const body = JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'Plain' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const { fetch } = scripted([() => new Response(body)])
    const usages: unknown[] = []
    const reply = await port(fetch).chat(anthropicCall, SIGNAL, (u) => usages.push(u))
    expect(reply).toEqual({ text: 'Plain', stop: 'complete' })
    expect(usages).toHaveLength(1)
  })

  test('a stalled stream aborts at the idle timeout with a ModelError', async () => {
    const stalled = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const p = iuModelPort({ env: ENV, fetch: stalled, backoffMs: 1, idleTimeoutMs: 20 })
    expect((await rejected(p.chat(chatCall, SIGNAL, () => {}))).message).toContain('stream idle')
  })

  test('a tool round that never answers is cut by the hang guard and fails as a ModelError', async () => {
    let calls = 0
    const stalled = (_url: string, init: RequestInit) => {
      calls++
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    const p = iuModelPort({ env: ENV, fetch: stalled, backoffMs: 1, hangGuardMs: 20 })
    expect(await rejected(p.round(roundCall, SIGNAL, () => {}))).toBeInstanceOf(ModelError)
    // A hang is terminal: the wait is spent and the abandoned request may still bill, so it is not retried.
    expect(calls).toBe(1)
  })

  test('a missing key or a base URL not ending in /anthropic is a ModelError', async () => {
    const { fetch } = scripted([])
    expect(
      (await rejected(iuModelPort({ env: { IU_BASE_URL: ENV.IU_BASE_URL }, fetch }).chat(chatCall, SIGNAL, () => {})))
        .message,
    ).toContain('IU_API_KEY')
    expect(
      (
        await rejected(
          iuModelPort({ env: { IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com' }, fetch }).chat(
            chatCall,
            SIGNAL,
            () => {},
          ),
        )
      ).message,
    ).toContain('/anthropic')
  })

  test('a round on chat completions returns the message untouched with its finish reason and reports usage', async () => {
    const message: WireMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    }
    const json = {
      choices: [{ message, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
    }
    const { seen, fetch } = scripted([() => Response.json(json)])
    const { usages, onUsage } = usageSink()
    const reply = await port(fetch).round(roundCall, SIGNAL, onUsage)
    expect(reply.message).toEqual(message)
    expect(reply.finishReason).toBe('tool_calls')
    expect(usages).toEqual([
      { model: 'fake-model', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.001 },
    ])
    expect(seen[0]?.url).toBe('https://iu.example.com/openai/v1/chat/completions')
  })

  test('a round on the responses API posts to /responses and parses function calls', async () => {
    const json = {
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' }],
      usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
    }
    const { seen, fetch } = scripted([() => Response.json(json)])
    const { usages, onUsage } = usageSink()
    const reply = await port(fetch).round({ ...roundCall, api: 'responses' }, SIGNAL, onUsage)
    expect(seen[0]?.url).toBe('https://iu.example.com/openai/v1/responses')
    expect(reply.message.tool_calls?.[0]?.id).toBe('c1')
    expect(reply.raw).toEqual(json.output)
    expect(usages[0]?.tokens).toEqual({ input: 20, output: 5, cacheRead: 8, reasoning: 0 })
  })

  test('a round retries a 503 and a garbled body, and surfaces a 402 as a balance failure', async () => {
    const ok = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }
    const retry = scripted([
      () => new Response('busy', { status: 503 }),
      () => new Response('{"choices":[{"mess'),
      () => Response.json(ok),
    ])
    expect((await port(retry.fetch).round(roundCall, SIGNAL, () => {})).message.content).toBe('done')
    expect(retry.seen).toHaveLength(3)

    const broke = scripted([() => new Response('payment required', { status: 402 })])
    const error = await port(broke.fetch)
      .round(roundCall, SIGNAL, () => {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).balance).toBe(true)
  })

  test('an aborted signal is not retried', async () => {
    const abort = new AbortController()
    const fetch = async () => {
      abort.abort(new Error('cancelled'))
      throw new Error('socket closed')
    }
    expect((await rejected(port(fetch).round(roundCall, abort.signal, () => {}))).message).toContain('cancelled')
  })
})
