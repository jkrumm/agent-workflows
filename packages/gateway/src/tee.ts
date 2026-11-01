import { brotliDecompressSync, constants, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'
import type { ProviderUsage } from '@agent-workflows/routes/pricing'
import { isRecord } from './json.ts'

/** A held copy, and what it decodes to, stops here and the usage is given up: no JSON or SSE response comes close. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
/** One SSE event past this ends the parsing of that response; the caller's bytes go on untouched. */
const MAX_PENDING_EVENT_CHARS = 1024 * 1024

/** The token columns of `usage.records`: additive, `input` without cache, `output` without reasoning. */
export interface TokenColumns {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  reasoning: number
}

/** The provider's block as `costFromUsage` reads it, with the per-use counts it does not price. */
export type ReportedUsage = ProviderUsage & { server_tool_use?: unknown }

export interface TeeResult {
  /** The merged provider usage block. */
  usage: ReportedUsage | null
  tokens: TokenColumns | null
  model: string | null
  /** An SSE stream carried an `error` event after its 2xx. */
  streamError: boolean
  /** The block is whole: both sides counted, and a stream's final counts arrived (or the provider stated a cost). */
  complete: boolean
  /** Response body bytes seen, decoded when the copy could be. */
  bytesReceived: number
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const nested = (block: Record<string, unknown>, key: string, field: string): number | null => {
  const inner = block[key]
  return isRecord(inner) ? count(inner[field]) : null
}

/**
 * Decodes a copy; a truncated body (an aborted stream) yields what it holds. Throws past `MAX_BUFFERED_BYTES` of output:
 * a small compressed body must not inflate without bound on the event loop.
 */
export function decodeBody(bytes: Uint8Array, encoding: string | null): Uint8Array {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return bytes
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: MAX_BUFFERED_BYTES })
    case 'deflate':
      return inflateSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: MAX_BUFFERED_BYTES })
    case 'br':
      return brotliDecompressSync(bytes, {
        finishFlush: constants.BROTLI_OPERATION_FLUSH,
        maxOutputLength: MAX_BUFFERED_BYTES,
      })
    case 'zstd':
      return zstdDecompressSync(bytes, { maxOutputLength: MAX_BUFFERED_BYTES })
    default:
      throw new Error(`unsupported content-encoding ${encoding}`)
  }
}

function anthropicColumns(usage: Record<string, unknown>): TokenColumns | null {
  const input = count(usage.input_tokens)
  const output = count(usage.output_tokens)
  const cacheRead = count(usage.cache_read_input_tokens)
  const total = count(usage.cache_creation_input_tokens)
  const split5m = nested(usage, 'cache_creation', 'ephemeral_5m_input_tokens')
  const cacheWrite1h = nested(usage, 'cache_creation', 'ephemeral_1h_input_tokens') ?? 0
  if (input === null && output === null && cacheRead === null && total === null) return null
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite5m: total === null ? (split5m ?? 0) : Math.max(0, total - cacheWrite1h),
    cacheWrite1h,
    reasoning: 0,
  }
}

/** OpenAI chat (`prompt_tokens`) and Responses (`input_tokens` + `*_details`): input and output both include their subset. */
function openAiColumns(usage: Record<string, unknown>): TokenColumns | null {
  const chat = count(usage.prompt_tokens) !== null || count(usage.completion_tokens) !== null
  const responses = isRecord(usage.input_tokens_details) || isRecord(usage.output_tokens_details)
  if (!chat && !responses) return null
  const input = count(chat ? usage.prompt_tokens : usage.input_tokens) ?? 0
  const output = count(chat ? usage.completion_tokens : usage.output_tokens) ?? 0
  const cacheRead = nested(usage, chat ? 'prompt_tokens_details' : 'input_tokens_details', 'cached_tokens') ?? 0
  const reasoning = nested(usage, chat ? 'completion_tokens_details' : 'output_tokens_details', 'reasoning_tokens') ?? 0
  return {
    input: Math.max(0, input - cacheRead),
    output: Math.max(0, output - reasoning),
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning,
  }
}

function geminiColumns(usage: Record<string, unknown>): TokenColumns | null {
  const prompt = count(usage.promptTokenCount)
  const output = count(usage.candidatesTokenCount)
  if (prompt === null && output === null) return null
  const cacheRead = count(usage.cachedContentTokenCount) ?? 0
  return {
    input: Math.max(0, (prompt ?? 0) - cacheRead),
    output: output ?? 0,
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: count(usage.thoughtsTokenCount) ?? 0,
  }
}

/**
 * The copy of a response that yields its usage, fed chunk by chunk beside the caller's bytes. Plain SSE is parsed as it
 * arrives, so an aborted stream still has what it reported; JSON and any encoded body are held and read at the end
 * (the caller's bytes stay untouched, only this copy is decoded). Other content types are not read: tokens null.
 */
export class UsageTee {
  private readonly encoding: string | null
  private readonly sse: boolean
  private readonly held: Uint8Array[] | null
  private heldBytes = 0
  private gaveUp = false
  private readonly decoder = new TextDecoder()
  private rest = ''
  private usage: Record<string, unknown> | null = null
  private gemini: Record<string, unknown> | null = null
  private model: string | null = null
  private streamError = false
  private received = 0
  /** Anthropic's `message_start` came and its `message_delta` has not. */
  private awaitingFinal = false
  /** An event outgrew the cap: what came before stands, the block is not complete. */
  private abandoned = false

  constructor(response: { contentType: string | null; contentEncoding: string | null }) {
    const type = (response.contentType ?? '').toLowerCase()
    const encoding = (response.contentEncoding ?? '').trim().toLowerCase()
    this.encoding = encoding === '' || encoding === 'identity' ? null : encoding
    this.sse = type.includes('text/event-stream')
    const live = this.sse && this.encoding === null
    this.held = !live && (this.sse || type.includes('json')) ? [] : null
  }

  push(chunk: Uint8Array): void {
    this.received += chunk.byteLength
    if (this.sse && this.encoding === null) {
      this.feedSse(this.decoder.decode(chunk, { stream: true }))
      return
    }
    if (this.held === null || this.gaveUp) return
    this.heldBytes += chunk.byteLength
    if (this.heldBytes > MAX_BUFFERED_BYTES) {
      this.gaveUp = true
      this.held.length = 0
      return
    }
    this.held.push(chunk)
  }

  /** What the stream reported, as far as it went. Never throws: an undecodable copy reads as no usage. */
  finish(): TeeResult {
    try {
      if (this.held !== null && !this.gaveUp) this.readHeld(this.held)
      else if (this.rest !== '') this.event(this.rest)
    } catch {
      // The caller got the bytes as they came; only this copy is unreadable.
    }
    return {
      usage: this.usage,
      tokens: this.columns(),
      model: this.model,
      streamError: this.streamError,
      complete: this.complete(),
      bytesReceived: this.received,
    }
  }

  private complete(): boolean {
    if (this.abandoned) return false
    if (this.gemini !== null) return geminiColumns(this.gemini) !== null
    if (this.usage === null || this.awaitingFinal) return false
    if (count(this.usage.cost) !== null) return true
    const input = count(this.usage.input_tokens) ?? count(this.usage.prompt_tokens)
    const output = count(this.usage.output_tokens) ?? count(this.usage.completion_tokens)
    return input !== null && output !== null
  }

  private readHeld(chunks: Uint8Array[]): void {
    const decoded = decodeBody(Buffer.concat(chunks), this.encoding)
    this.received = Math.max(this.received, decoded.byteLength)
    const text = new TextDecoder().decode(decoded)
    if (this.sse) {
      this.feedSse(`${text}\n\n`)
      return
    }
    this.observe(JSON.parse(text))
  }

  private columns(): TokenColumns | null {
    if (this.gemini !== null) return geminiColumns(this.gemini)
    if (this.usage === null) return null
    return openAiColumns(this.usage) ?? anthropicColumns(this.usage)
  }

  private feedSse(text: string): void {
    if (this.abandoned) return
    this.rest = (this.rest + text).replaceAll('\r\n', '\n')
    let end = this.rest.indexOf('\n\n')
    while (end >= 0 && end <= MAX_PENDING_EVENT_CHARS) {
      this.event(this.rest.slice(0, end))
      this.rest = this.rest.slice(end + 2)
      end = this.rest.indexOf('\n\n')
    }
    if (end > MAX_PENDING_EVENT_CHARS || (end < 0 && this.rest.length > MAX_PENDING_EVENT_CHARS)) {
      this.abandoned = true
      this.rest = ''
    }
  }

  private event(block: string): void {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data === '' || data === '[DONE]') return
    try {
      this.observe(JSON.parse(data))
    } catch {
      // A partial event of an aborted stream, or a keep-alive that is no JSON.
    }
  }

  /** One SSE event or a whole JSON body. Anthropic's `message`, OpenAI Responses' `response` hold the block in events. */
  private observe(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.observe(item)
      return
    }
    if (!isRecord(value)) return
    if (value.type === 'error') this.streamError = true
    if (value.type === 'message_start') this.awaitingFinal = true
    if (value.type === 'message_delta' && isRecord(value.usage)) this.awaitingFinal = false
    if (isRecord(value.message)) this.read(value.message)
    if (isRecord(value.response)) this.read(value.response)
    this.read(value)
  }

  private read(source: Record<string, unknown>): void {
    if (typeof source.model === 'string') this.model = source.model
    if (typeof source.modelVersion === 'string') this.model = source.modelVersion
    if (isRecord(source.usageMetadata)) this.gemini = source.usageMetadata
    if (!isRecord(source.usage)) return
    // Anthropic: `message_start` has the input side, `message_delta` the final output; later values win, a null never.
    const reported = Object.entries(source.usage).filter(([, field]) => field !== null && field !== undefined)
    this.usage = { ...this.usage, ...Object.fromEntries(reported) }
  }
}
