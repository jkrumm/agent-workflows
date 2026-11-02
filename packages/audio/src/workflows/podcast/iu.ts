import { BALANCE_MARKER, isBalanceFailure } from '../../../../routes/src/index.ts'
import { audioTransports } from '../../config.ts'
import { type Attribution, gatewayHeaders } from '../../gateway.ts'
import type {
  ChatCall,
  ChatReply,
  ModelPort,
  OnWireUsage,
  RoundCall,
  RoundReply,
  ToolCallRequest,
  WireMessage,
  WireUsage,
} from './llm.ts'
import { ANTHROPIC_MIN_MAX_TOKENS, ModelError } from './llm.ts'

// The production `ModelPort`: the gateway's OpenAI chat completions and responses, and its native Anthropic Messages route.
// The platform transports (capabilities `transports/`) are single-call text wires without tools, cache blocks or a
// response schema; the room needs all three, so this adapter ports audio-gateway's wire code (`llm-tools.ts`,
// `anthropic-messages.ts`, `callPodcastLlm`) onto the platform's conventions: the local gateway from `AGW_GATEWAY_URL`
// and `AGW_API_SECRET`, the step's attribution on every call, streaming with an idle watchdog where the answer
// is a single text, a 30-minute hang guard on a non-streamed tool round (never a budget, rules/agent-limits.md), and
// provider-balance failures marked for the route's fallback.

const ANTHROPIC_VERSION = '2023-06-01'
const ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
/** SSE `error` event types that are transient. */
const RETRYABLE_STREAM_ERRORS = new Set(['overloaded_error', 'api_error', 'rate_limit_error'])

export interface IuOptions {
  env?: Record<string, string | undefined>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Streamed calls: abort after this long without a chunk. Default 5 minutes. */
  idleTimeoutMs?: number
  /** Non-streamed tool rounds: a hang guard, never a budget. Default 30 minutes. */
  hangGuardMs?: number
  /** Base of the 3x backoff between attempts. Default 500. */
  backoffMs?: number
}

class Retryable extends Error {}

/** The payload of an SSE `data:` line; null for any other line, a blank payload and `[DONE]`. */
function ssePayload(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice('data:'.length).trim()
  return payload && payload !== '[DONE]' ? payload : null
}

/** The gateway's bearer and bases (`audioTransports`); a misconfiguration is a `ModelError`, never echoing a value. */
function gateway(env: Record<string, string | undefined>) {
  try {
    return audioTransports(env)
  } catch (error) {
    throw new ModelError(error instanceof Error ? error.message : String(error))
  }
}

/** Headers of a text call: the bearer and the step's attribution. The gateway writes the usage row of these calls. */
const callHeaders = (token: string, attribution: Attribution | undefined, extra: Record<string, string> = {}) => ({
  ...gatewayHeaders(attribution),
  ...extra,
  authorization: `Bearer ${token}`,
})

/**
 * Headers of a Messages call. `x-agw-fallback: none`: with no credit left the gateway answers 402 (balance) and the
 * route's own fallback takes the call, never IU's Claude.
 */
const anthropicHeaders = (token: string, attribution: Attribution | undefined) =>
  callHeaders(token, attribution, {
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'x-agw-fallback': 'none',
  })

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const providerCost = (u: Record<string, unknown>) =>
  typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null

/** Chat completions usage: `prompt_tokens` includes cached, `completion_tokens` includes reasoning. */
function openaiUsage(raw: unknown, model: string): WireUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = rec(raw)
  return {
    model,
    tokens: {
      input: num(u.prompt_tokens),
      output: num(u.completion_tokens),
      cacheRead: num(rec(u.prompt_tokens_details).cached_tokens),
      reasoning: num(rec(u.completion_tokens_details).reasoning_tokens),
    },
    cost: providerCost(u),
  }
}

/** Responses usage: `input_tokens` includes cached, `output_tokens` includes reasoning. */
function responsesUsage(raw: unknown, model: string): WireUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = rec(raw)
  return {
    model,
    tokens: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(rec(u.input_tokens_details).cached_tokens),
      reasoning: num(rec(u.output_tokens_details).reasoning_tokens),
    },
    cost: providerCost(u),
  }
}

/** Messages usage: `input_tokens` EXCLUDES cache reads and writes; thinking is inside `output_tokens`. */
function anthropicUsage(u: AnthropicUsage, model: string): WireUsage {
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  return {
    model,
    tokens: {
      input: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
      output: u.output_tokens ?? 0,
      cacheRead,
      cacheWrite,
      reasoning: 0,
    },
    cost: u.cost ?? null,
  }
}

export function iuModelPort(options: IuOptions = {}): ModelPort {
  const doFetch = options.fetch ?? fetch
  const idleMs = options.idleTimeoutMs ?? 5 * 60_000
  const hangMs = options.hangGuardMs ?? 30 * 60_000
  const backoffMs = options.backoffMs ?? 500

  /** One request with retries: 429/5xx (not a relayed `invalid_request_error`), a cut stream, an unreadable 2xx. */
  async function withRetries<T>(wire: string, signal: AbortSignal, attempt: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await attempt()
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (!(error instanceof Retryable) || i >= ATTEMPTS - 1) {
          if (error instanceof ModelError) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new ModelError(message.startsWith(wire) ? message : `${wire}: ${message}`)
        }
        await Bun.sleep(backoffMs * 3 ** i)
      }
    }
  }

  async function failed(res: Response, wire: string): Promise<Error> {
    const body = await res.text().catch(() => '')
    const detail = body.slice(0, 300)
    if (isBalanceFailure({ status: res.status, text: body })) {
      return new ModelError(
        `${wire} ${BALANCE_MARKER} (${res.status}): ${detail}`,
        true,
        res.headers.get('x-agw-request-id') ?? undefined,
      )
    }
    const message = `${wire} request failed (${res.status}): ${detail}`
    return RETRYABLE_STATUS.has(res.status) && !detail.includes('invalid_request_error')
      ? new Retryable(message)
      : new ModelError(message)
  }

  /** A streamed POST under the idle watchdog; `onLine` sees every line of the body as it arrives. */
  async function stream(
    wire: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
    onLine: (line: string) => void,
    onSent: () => void,
  ) {
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), idleMs)
    }
    try {
      arm()
      onSent()
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, idle.signal]),
      })
      if (!res.ok) throw await failed(res, wire)
      if (!res.body) throw new Retryable(`${wire} response had no body`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const line = onLine
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const l of lines) line(l)
      }
      line(buffer + decoder.decode())
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted) throw new ModelError(`${wire} stream idle for ${idleMs}ms`)
      if (error instanceof ModelError || error instanceof Retryable || signal.aborted) throw error
      throw new Retryable(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  async function openaiChat(
    call: ChatCall,
    signal: AbortSignal,
    onUsage: OnWireUsage,
    onSent: () => void,
  ): Promise<ChatReply> {
    const { token, openaiBase } = gateway(options.env ?? process.env)
    return withRetries('iu-openai', signal, async () => {
      let text = ''
      let finish: string | undefined
      let model = call.model
      let usage: WireUsage | undefined
      try {
        await stream(
          'iu-openai',
          `${openaiBase}/chat/completions`,
          callHeaders(token, call.attribution, { 'content-type': 'application/json' }),
          {
            model: call.model,
            messages: [
              { role: 'system', content: call.system },
              { role: 'user', content: call.user },
            ],
            max_completion_tokens: call.maxTokens,
            ...(call.effort ? { reasoning_effort: call.effort } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          signal,
          (raw) => {
            const payload = ssePayload(raw)
            if (payload === null) return
            let chunk: Record<string, unknown>
            try {
              chunk = rec(JSON.parse(payload))
            } catch {
              throw new Retryable('iu-openai sent a malformed stream chunk')
            }
            if (typeof chunk.model === 'string') model = chunk.model
            const choice = rec((chunk.choices as unknown[] | undefined)?.[0])
            const content = rec(choice.delta).content
            if (typeof content === 'string') text += content
            if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
            if (chunk.usage) usage = openaiUsage(chunk.usage, model)
          },
          onSent,
        )
        if (!finish) throw new Retryable('iu-openai stream ended without a finish reason')
      } finally {
        if (usage) onUsage(usage)
      }
      const stop = finish === 'stop' ? 'complete' : finish === 'length' ? 'length' : 'other'
      return { text, stop, ...(stop === 'other' ? { stopDetail: finish } : {}) }
    })
  }

  async function anthropicChat(
    call: ChatCall,
    signal: AbortSignal,
    onUsage: OnWireUsage,
    onSent: () => void,
  ): Promise<ChatReply> {
    const { token, anthropicBase } = gateway(options.env ?? process.env)
    const body = anthropicBody(call)
    return withRetries('anthropic', signal, async () => {
      const events: string[] = []
      await stream(
        'anthropic',
        `${anthropicBase}/v1/messages`,
        anthropicHeaders(token, call.attribution),
        body,
        signal,
        // The whole body: SSE events, or a plain JSON message or error envelope from a proxy that ignores `stream`.
        (raw) => events.push(raw),
        onSent,
      )
      const parsed = parseAnthropicStream(events.join('\n'))
      if (!parsed.ok) throw new Retryable(`unreadable response: ${parsed.reason}`)
      const { text, stopReason, usage, streamError } = parsed.value
      if (Object.keys(usage).length > 0) onUsage(anthropicUsage(usage, call.model))
      if (streamError) {
        const message = `anthropic ${streamError.type}: ${streamError.message}`.slice(0, 500)
        throw RETRYABLE_STREAM_ERRORS.has(streamError.type) ? new Retryable(message) : new ModelError(message)
      }
      const stop =
        stopReason === 'end_turn' || stopReason === 'stop_sequence'
          ? 'complete'
          : stopReason === 'max_tokens'
            ? 'length'
            : 'other'
      return { text, stop, ...(stop === 'other' ? { stopDetail: stopReason ?? 'none' } : {}) }
    })
  }

  /** A Messages tool round: streamed under the idle watchdog, the content blocks rebuilt, the reply normalised. */
  async function anthropicRound(
    call: RoundCall,
    signal: AbortSignal,
    onUsage: OnWireUsage,
    onSent: () => void,
  ): Promise<RoundReply> {
    const { token, anthropicBase } = gateway(options.env ?? process.env)
    const body = anthropicRoundBody(call)
    return withRetries('anthropic', signal, async () => {
      const events: string[] = []
      await stream(
        'anthropic',
        `${anthropicBase}/v1/messages`,
        anthropicHeaders(token, call.attribution),
        body,
        signal,
        (raw) => events.push(raw),
        onSent,
      )
      const parsed = parseAnthropicMessage(events.join('\n'))
      if (!parsed.ok) throw new Retryable(`unreadable response: ${parsed.reason}`)
      const { blocks, stopReason, usage, streamError } = parsed.value
      if (Object.keys(usage).length > 0) onUsage(anthropicUsage(usage, call.model))
      if (streamError) {
        const message = `anthropic ${streamError.type}: ${streamError.message}`.slice(0, 500)
        throw RETRYABLE_STREAM_ERRORS.has(streamError.type) ? new Retryable(message) : new ModelError(message)
      }
      return anthropicReply(blocks, stopReason)
    })
  }

  async function round(
    call: RoundCall,
    signal: AbortSignal,
    onUsage: OnWireUsage,
    onSent: () => void,
  ): Promise<RoundReply> {
    if (call.api === 'messages') return anthropicRound(call, signal, onUsage, onSent)
    const { token, openaiBase } = gateway(options.env ?? process.env)
    const responses = call.api === 'responses'
    const wire = responses ? 'iu-responses' : 'iu-openai'
    return withRetries(wire, signal, async () => {
      let res: Response
      try {
        onSent()
        res = await doFetch(`${openaiBase}${responses ? '/responses' : '/chat/completions'}`, {
          method: 'POST',
          headers: callHeaders(token, call.attribution, { 'content-type': 'application/json' }),
          body: JSON.stringify(roundBody(call)),
          signal: AbortSignal.any([signal, AbortSignal.timeout(hangMs)]),
        })
      } catch (error) {
        if (signal.aborted) throw error
        // The hang guard fired: the wait is spent (and the abandoned request may still bill), so it is not retried.
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new ModelError(`${wire} round produced no response within ${Math.round(hangMs / 60_000)} minutes`)
        }
        throw new Retryable(error instanceof Error ? error.message : String(error))
      }
      if (!res.ok) throw await failed(res, wire)
      let json: Record<string, unknown>
      try {
        json = rec(JSON.parse(await res.text()))
      } catch {
        throw new Retryable(`${wire} body is not JSON (cut or garbled)`)
      }
      const usage = (responses ? responsesUsage : openaiUsage)(json.usage, call.model)
      if (usage) onUsage(usage)
      return responses ? parseResponsesReply(json) : parseChatReply(json)
    })
  }

  return {
    chat: (call, signal, onUsage, onSent) =>
      call.wire === 'anthropic'
        ? anthropicChat(call, signal, onUsage, onSent)
        : openaiChat(call, signal, onUsage, onSent),
    round,
  }
}

/** The Messages body: adaptive thinking with `output_config.effort`, the `max_tokens` floor, the cached prefix, the schema. */
export function anthropicBody(call: ChatCall) {
  const thinking = call.effort !== undefined
  const outputConfig = {
    ...(thinking ? { effort: call.effort } : {}),
    ...(call.jsonSchema ? { format: { type: 'json_schema', schema: call.jsonSchema } } : {}),
  }
  return {
    model: call.model,
    max_tokens: Math.max(ANTHROPIC_MIN_MAX_TOKENS, call.maxTokens),
    ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    system: buildSystem(call.system, call.cacheablePrefix),
    messages: [{ role: 'user', content: call.user }],
    stream: true,
  }
}

/** Block types a cache breakpoint cannot sit on. */
const UNCACHEABLE_BLOCKS = new Set(['thinking', 'redacted_thinking'])

/**
 * The transcript with an ephemeral breakpoint on the last content block of the last message, so the next round reads
 * this one's whole transcript from the prompt cache. Copies the touched message and block; the caller's transcript
 * (whose assistant blocks are echoed verbatim) is never mutated. A last message without a cacheable block is left alone.
 */
function withTailBreakpoint(messages: WireMessage[]): WireMessage[] {
  const last = messages.at(-1)
  const blocks = last && Array.isArray(last.content) ? last.content : undefined
  const tail = blocks?.at(-1)
  if (!last || !blocks || !tail || UNCACHEABLE_BLOCKS.has(String(rec(tail).type))) return messages
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...blocks.slice(0, -1), { ...rec(tail), cache_control: { type: 'ephemeral' } }] },
  ]
}

/**
 * The Messages tool-round body: the same thinking/effort and `max_tokens` floor as a single call, `tools` before the
 * system prompt (the Messages cache order), the system prompt as one block with an ephemeral breakpoint (left out when
 * empty), and the transcript with a second breakpoint on its tail (two of the four allowed). Every field is a pure
 * function of the transcript, so with the markers stripped round N's prompt is a prefix of round N+1's.
 */
export function anthropicRoundBody(call: RoundCall) {
  const thinking = call.effort !== undefined
  return {
    model: call.model,
    max_tokens: Math.max(ANTHROPIC_MIN_MAX_TOKENS, call.maxTokens),
    ...(thinking ? { thinking: { type: 'adaptive' }, output_config: { effort: call.effort } } : {}),
    ...(call.tools.length > 0
      ? { tools: call.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
      : {}),
    ...(call.system?.trim()
      ? { system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }] }
      : {}),
    messages: withTailBreakpoint(call.messages),
    stream: true,
  }
}

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

/**
 * `system` as one string, or as the episode-constant prefix in its own block with an ephemeral `cache_control`
 * breakpoint plus the per-call remainder, so repeat calls read the prefix from the prompt cache. A prefix that does not
 * lead the system prompt is sent uncached, with a warning (a prompt edit that drifts it costs money silently otherwise).
 */
export function buildSystem(system: string, cacheablePrefix?: string): string | SystemBlock[] {
  if (!cacheablePrefix) return system
  if (!system.startsWith(cacheablePrefix)) {
    console.warn(
      JSON.stringify({ level: 'warn', message: 'anthropic cacheable prefix does not lead the system prompt' }),
    )
    return system
  }
  const rest = system.slice(cacheablePrefix.length)
  const blocks: SystemBlock[] = [{ type: 'text', text: cacheablePrefix, cache_control: { type: 'ephemeral' } }]
  if (rest.trim()) blocks.push({ type: 'text', text: rest })
  return blocks
}

/** The tool-round body: chat completions with `tools`, or responses with `instructions` + `input`. */
export function roundBody(call: RoundCall) {
  if (call.api === 'responses') {
    return {
      model: call.model,
      input: call.messages.filter((m) => m.role !== 'system'),
      instructions: call.messages.find((m) => m.role === 'system')?.content ?? undefined,
      max_output_tokens: call.maxTokens,
      ...(call.tools.length > 0
        ? {
            tools: call.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(call.effort ? { reasoning: { effort: call.effort } } : {}),
    }
  }
  return {
    model: call.model,
    messages: call.messages,
    max_completion_tokens: call.maxTokens,
    ...(call.tools.length > 0
      ? {
          tools: call.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(call.effort ? { reasoning_effort: call.effort } : {}),
  }
}

/** The assistant message exactly as the provider sent it: it goes back into the transcript untouched. */
export function parseChatReply(json: Record<string, unknown>): RoundReply {
  const choice = rec((json.choices as unknown[] | undefined)?.[0])
  const message = (choice.message as WireMessage | undefined) ?? { role: 'assistant', content: '' }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined
  return { message, ...(finishReason ? { finishReason } : {}) }
}

/** A `/v1/responses` reply: text joined, `function_call` items as chat-style tool calls, `raw` kept for echoing. */
export function parseResponsesReply(json: Record<string, unknown>): RoundReply {
  const output = (Array.isArray(json.output) ? json.output : []) as WireMessage[]
  const text = output
    .filter((o) => o.type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? (o.content as { type?: string; text?: string }[]) : []))
    .map((c) => (c.type === 'output_text' ? (c.text ?? '') : ''))
    .join('')
  const toolCalls: ToolCallRequest[] = output
    .filter((o) => o.type === 'function_call')
    .map((o) => ({
      id: String(o.call_id ?? ''),
      type: 'function' as const,
      function: { name: String(o.name ?? ''), arguments: String(o.arguments ?? '') },
    }))
  const status = typeof json.status === 'string' ? json.status : undefined
  const reason = rec(json.incomplete_details).reason
  // Chat vocabulary on both APIs: completed → stop, cut at the token budget → length.
  const finishReason =
    status === 'completed' ? 'stop' : status === 'incomplete' && reason === 'max_output_tokens' ? 'length' : status
  return {
    message: { role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
    ...(finishReason ? { finishReason } : {}),
    raw: output,
  }
}

const FINISH_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
}

/**
 * A Messages reply as a round: the text blocks joined, `tool_use` blocks as chat-style tool calls (the `input` object
 * re-serialised), the finish reason in chat vocabulary, the content blocks kept verbatim as `native` for the next request.
 * A `max_tokens` stop carries NO tool calls: a cut `tool_use` is never run.
 */
export function anthropicReply(blocks: Array<Record<string, unknown>>, stopReason: string | null): RoundReply {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
  const toolCalls: ToolCallRequest[] =
    stopReason === 'max_tokens'
      ? []
      : blocks
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({
            id: String(b.id ?? ''),
            type: 'function' as const,
            function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
          }))
  const finishReason = stopReason ? (FINISH_REASONS[stopReason] ?? stopReason) : undefined
  return {
    message: {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      native: { api: 'anthropic', items: blocks },
    },
    ...(finishReason ? { finishReason } : {}),
  }
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cost?: number
}

export interface AnthropicMessageResult {
  /** Concatenated `text` blocks only; thinking blocks are skipped. */
  text: string
  stopReason: string | null
  usage: AnthropicUsage
  streamError?: { type: string; message: string }
}

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cost',
] as const

function mergeUsage(into: AnthropicUsage, from: unknown) {
  const source = rec(from)
  for (const key of USAGE_KEYS) {
    const n = source[key]
    if (typeof n === 'number') into[key] = n
  }
}

function toStreamError(raw: unknown): { type: string; message: string } {
  const error = rec(raw)
  return {
    type: typeof error.type === 'string' ? error.type : 'unknown',
    message: typeof error.message === 'string' ? error.message : '',
  }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * A Messages response as an SSE stream (or a plain JSON body from a proxy that ignores `stream`, including an
 * `{"type":"error"}` envelope) into its text blocks, stop reason and usage. Never throws; an unreadable body is
 * `{ ok: false }`.
 */
export function parseAnthropicStream(
  body: string,
): { ok: true; value: AnthropicMessageResult } | { ok: false; reason: string } {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('data:') && !trimmed.startsWith('event:') && !trimmed.startsWith(':')) {
    const json = tryParse(body)
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, reason: body.trim() === '' ? 'empty body' : 'body is not a JSON object' }
    }
    const message = rec(json)
    if (message.type === 'error') {
      return { ok: true, value: { text: '', stopReason: null, usage: {}, streamError: toStreamError(message.error) } }
    }
    if (!Array.isArray(message.content)) return { ok: false, reason: 'JSON body has no content array' }
    const text = (message.content as unknown[])
      .map(rec)
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
    const usage: AnthropicUsage = {}
    mergeUsage(usage, message.usage)
    const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null
    return { ok: true, value: { text, stopReason, usage } }
  }
  const textBlocks = new Set<number>()
  let text = ''
  let stopReason: string | null = null
  const usage: AnthropicUsage = {}
  let streamError: AnthropicMessageResult['streamError']
  let sawEvent = false
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    const event = tryParse(payload)
    if (!event || typeof event !== 'object') continue
    sawEvent = true
    const e = rec(event)
    const index = typeof e.index === 'number' ? e.index : undefined
    const delta = rec(e.delta)
    switch (e.type) {
      case 'message_start':
        mergeUsage(usage, rec(e.message).usage)
        break
      case 'content_block_start': {
        const block = rec(e.content_block)
        if (block.type === 'text' && index !== undefined) {
          textBlocks.add(index)
          text += typeof block.text === 'string' ? block.text : ''
        }
        break
      }
      case 'content_block_delta':
        if (delta.type === 'text_delta' && index !== undefined && textBlocks.has(index)) {
          text += typeof delta.text === 'string' ? delta.text : ''
        }
        break
      case 'message_delta':
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason
        mergeUsage(usage, e.usage)
        break
      case 'error':
        streamError = toStreamError(e.error)
        break
    }
  }
  if (!sawEvent) return { ok: false, reason: 'SSE body carried no valid events' }
  return { ok: true, value: { text, stopReason, usage, ...(streamError ? { streamError } : {}) } }
}

export interface AnthropicBlocksResult {
  /** The content blocks as the provider sent them: thinking (signature included), redacted thinking, text, tool use. */
  blocks: Array<Record<string, unknown>>
  stopReason: string | null
  usage: AnthropicUsage
  streamError?: { type: string; message: string }
}

/**
 * A Messages response (SSE stream, or a plain JSON message or `{"type":"error"}` envelope from a proxy that ignores
 * `stream`) into its content blocks, rebuilt from the deltas, with the stop reason and usage. Never throws; `{ ok: false }`
 * (retryable) for an unreadable body, a stream cut before its stop reason, or a `tool_use` whose input JSON is garbled
 * on a stop that was not `max_tokens` (a cut one is dropped by `anthropicReply`).
 */
export function parseAnthropicMessage(
  body: string,
): { ok: true; value: AnthropicBlocksResult } | { ok: false; reason: string } {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('data:') && !trimmed.startsWith('event:') && !trimmed.startsWith(':')) {
    const json = tryParse(body)
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, reason: body.trim() === '' ? 'empty body' : 'body is not a JSON object' }
    }
    const message = rec(json)
    if (message.type === 'error') {
      return { ok: true, value: { blocks: [], stopReason: null, usage: {}, streamError: toStreamError(message.error) } }
    }
    if (!Array.isArray(message.content)) return { ok: false, reason: 'JSON body has no content array' }
    const usage: AnthropicUsage = {}
    mergeUsage(usage, message.usage)
    const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null
    return { ok: true, value: { blocks: (message.content as unknown[]).map(rec), stopReason, usage } }
  }
  const blocks = new Map<number, Record<string, unknown>>()
  const inputJson = new Map<number, string>()
  let stopReason: string | null = null
  const usage: AnthropicUsage = {}
  let streamError: AnthropicBlocksResult['streamError']
  let sawEvent = false
  const append = (block: Record<string, unknown>, key: string, piece: unknown) => {
    block[key] = `${typeof block[key] === 'string' ? block[key] : ''}${typeof piece === 'string' ? piece : ''}`
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    const event = tryParse(payload)
    if (!event || typeof event !== 'object') continue
    sawEvent = true
    const e = rec(event)
    const index = typeof e.index === 'number' ? e.index : undefined
    const delta = rec(e.delta)
    switch (e.type) {
      case 'message_start':
        mergeUsage(usage, rec(e.message).usage)
        break
      case 'content_block_start':
        if (index !== undefined) blocks.set(index, { ...rec(e.content_block) })
        break
      case 'content_block_delta': {
        const block = index === undefined ? undefined : blocks.get(index)
        if (!block || index === undefined) break
        if (delta.type === 'text_delta') append(block, 'text', delta.text)
        else if (delta.type === 'thinking_delta') append(block, 'thinking', delta.thinking)
        else if (delta.type === 'signature_delta') append(block, 'signature', delta.signature)
        else if (delta.type === 'input_json_delta') {
          inputJson.set(
            index,
            `${inputJson.get(index) ?? ''}${typeof delta.partial_json === 'string' ? delta.partial_json : ''}`,
          )
        }
        break
      }
      case 'message_delta':
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason
        mergeUsage(usage, e.usage)
        break
      case 'error':
        streamError = toStreamError(e.error)
        break
    }
  }
  if (!sawEvent) return { ok: false, reason: 'SSE body carried no valid events' }
  if (streamError) return { ok: true, value: { blocks: [], stopReason, usage, streamError } }
  if (stopReason === null) return { ok: false, reason: 'stream ended without a stop reason' }
  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b)
  for (const [index, block] of ordered) {
    if (block.type !== 'tool_use') continue
    const raw = inputJson.get(index)
    if (raw === undefined || raw.trim() === '') {
      block.input = rec(block.input)
      continue
    }
    const parsed = tryParse(raw)
    if (parsed === undefined && stopReason !== 'max_tokens') {
      return { ok: false, reason: `tool_use input is not valid JSON (${raw.length} chars)` }
    }
    block.input = rec(parsed)
  }
  return { ok: true, value: { blocks: ordered.map(([, block]) => block), stopReason, usage } }
}
