import { iuHeaders } from '../http.ts'
import type { AudioScope } from '../scope.ts'
import { synthConcurrent } from '../speech/core.ts'
import { measureFromOpenAiUsage } from '../usage.ts'

/** Carries a failed part's upstream response through `synthConcurrent`'s fail-fast throw. */
export class PartFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly contentType: string,
  ) {
    super(`stt chunk failed: ${status}`)
  }
}

/** `{ text, usage, language }` of an upstream body. Non-JSON bodies (Whisper's rich formats) pass through as text. */
export function extractTextAndUsage(
  body: string,
  contentType: string,
): { text: string; usage: unknown; language: string | null } {
  if (!contentType.includes('application/json')) return { text: body, usage: null, language: null }
  const json = JSON.parse(body) as Record<string, unknown>
  return {
    text: typeof json.text === 'string' ? json.text : '',
    usage: json.usage ?? null,
    language: (typeof json.language === 'string' ? json.language : null) ?? firstLanguageCode(json.languages),
  }
}

/** The OpenAI transcribe model reports `languages: [{code}]` instead of a `language` string. */
function firstLanguageCode(languages: unknown): string | null {
  const first: unknown = Array.isArray(languages) ? languages[0] : undefined
  if (typeof first !== 'object' || first === null || !('code' in first)) return null
  return typeof first.code === 'string' ? first.code : null
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Strip a verbatim echo of `prompt` from `text` (OpenAI treats `prompt` as a preceding segment, and a collapsed chunk
 * can echo it). Only where it stands as its own sentence; the same words mid-sentence stay. Case-sensitive, no fuzz.
 */
export function stripPromptEcho(text: string, prompt: string): string {
  const core = prompt.trim().replace(/[.!?]+$/, '')
  if (!core || !text.includes(core)) return text
  const pattern = new RegExp(`(^\\s*|[.!?]\\s+)${escapeRegExp(core)}[.!?]?(?=\\s|$)`, 'g')
  if (!pattern.test(text)) return text
  // Until stable: the pattern consumes the preceding terminator, so back-to-back echoes need a second pass. Bounded.
  let out = text
  for (let i = 0; i < 10; i++) {
    const next = out.replace(pattern, (_match, lead: string) => lead)
    if (next === out) break
    out = next
  }
  return out.replace(/\s+/g, ' ').trim()
}

export interface UpstreamReply {
  status: number
  body: string
  contentType: string
  latencyMs: number
}

/** One `POST /audio/transcriptions`. */
export async function postTranscription(scope: AudioScope, form: FormData): Promise<UpstreamReply> {
  const start = scope.deps.clock.now()
  const res = await scope.deps.fetch(`${scope.config.transports.openaiBase}/audio/transcriptions`, {
    method: 'POST',
    headers: iuHeaders(scope),
    body: form,
  })
  const body = await res.text()
  return {
    status: res.status,
    body,
    contentType: res.headers.get('content-type') ?? '',
    latencyMs: scope.deps.clock.now() - start,
  }
}

export interface TranscribePartsOptions {
  parts: File[]
  /** The requested route; each part tries it first. */
  routeId: string
  /** The route a part retries on alone when its own attempt hits `isModelUnavailable`. */
  fallbackRouteId: string | null
  isModelUnavailable: (status: number) => boolean
  /** The upstream form for one part attempt (always plain json). */
  buildUpstream: (routeId: string, part: File) => FormData
  /** Seconds of each part (from the cuts): per-minute pricing when the reply carries no duration. */
  partSeconds?: (index: number) => number | null
}

/**
 * Every part concurrently (`sttChunkConcurrency` wide). A part that hits an outage retries THAT PART ALONE on the
 * fallback: a whole-set retry would re-send and re-bill parts that already succeeded. Every HTTP call made is one usage
 * event. Throws `PartFailure` when a part (and its fallback) failed.
 */
export async function transcribeParts(
  scope: AudioScope,
  opts: TranscribePartsOptions,
): Promise<{ text: string; usedFallback: boolean }> {
  let usedFallback = false
  const texts = await synthConcurrent(scope.config.sttChunkConcurrency, opts.parts, async (part, index) => {
    let routeId = opts.routeId
    let reply = await postTranscription(scope, opts.buildUpstream(routeId, part))
    const failed = (r: UpstreamReply) => r.status < 200 || r.status >= 300
    if (failed(reply) && opts.isModelUnavailable(reply.status) && opts.fallbackRouteId) {
      scope.log.warn('stt chunk upstream unavailable; retrying this part on fallback', {
        model: scope.route(routeId).model,
        fallback: scope.route(opts.fallbackRouteId).model,
        status: reply.status,
        caller: scope.caller,
      })
      record(scope, routeId, reply, null)
      routeId = opts.fallbackRouteId
      usedFallback = true
      reply = await postTranscription(scope, opts.buildUpstream(routeId, part))
    }
    if (failed(reply)) {
      record(scope, routeId, reply, null)
      throw new PartFailure(reply.status, reply.body, reply.contentType)
    }
    const read = readReply(scope, routeId, reply, null, opts.partSeconds?.(index) ?? null)
    if ('failure' in read) throw new PartFailure(502, JSON.stringify(read.failure), 'application/json')
    return read.text
  })
  return { text: texts.join(' '), usedFallback }
}

/**
 * One transcription usage event. Seconds for per-minute pricing: the probed duration of the whole upload wins (legacy),
 * then the reply's own (`prompt_audio_seconds`, `{type: duration}`), then the part's cut length.
 */
export function record(
  scope: AudioScope,
  routeId: string,
  reply: UpstreamReply,
  usage: unknown,
  probedSeconds: number | null = null,
  cutSeconds: number | null = null,
  errorText: string | null = null,
): void {
  const ok = reply.status >= 200 && reply.status < 300
  const measure = measureFromOpenAiUsage(usage)
  scope.call({
    endpoint: 'transcriptions',
    routeId,
    model: scope.route(routeId).model,
    status: reply.status,
    latencyMs: reply.latencyMs,
    ...measure,
    // A probe that failed reports 0: that is no measurement, never a free call.
    audioSeconds: positive(probedSeconds) ?? positive(measure.audioSeconds) ?? positive(cutSeconds),
    errorText: errorText ?? (ok ? null : reply.body.slice(0, 500)),
  })
}

const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && n > 0 ? n : null)

export interface ReadFailure {
  error: { message: string; type: 'upstream_error' }
}

/**
 * A 2xx reply read into `{ text, language }` and recorded, billed or not. A body that cannot be read is still a billed
 * call: it is recorded first (priced from the duration we know, else unknown), then answered as a 502.
 */
export function readReply(
  scope: AudioScope,
  routeId: string,
  reply: UpstreamReply,
  probedSeconds: number | null,
  cutSeconds: number | null = null,
): { text: string; language: string | null } | { failure: ReadFailure } {
  try {
    const { text, usage, language } = extractTextAndUsage(reply.body, reply.contentType)
    record(scope, routeId, reply, usage, probedSeconds, cutSeconds)
    return { text, language }
  } catch {
    const message = `upstream ${scope.route(routeId).model} answered ${reply.status} with an unreadable body`
    record(scope, routeId, reply, null, probedSeconds, cutSeconds, `${message}: ${reply.body.slice(0, 300)}`)
    return { failure: { error: { message, type: 'upstream_error' } } }
  }
}
