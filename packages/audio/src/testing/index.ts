// Test support: a fake IU on a real socket answering like its OpenAI, Gemini and Replicate routes, plus deps with an
// instant clock and a recording usage port, so the production lanes are exercised over HTTP.
import { type AudioConfig, audioConfig } from '../config.ts'
import type { AudioDeps, AudioLog, Clock, Fetch } from '../scope.ts'
import type { RequestEvent, UsageEvent, UsagePort } from '../usage.ts'

export type FakeRoute =
  | 'chat'
  | 'speech'
  | 'transcriptions'
  | 'gemini'
  | 'geminiStream'
  | 'replicateCreate'
  | 'replicatePoll'
  | 'delivery'

export interface FakeRequest {
  route: FakeRoute
  path: string
  headers: Headers
  /** Parsed JSON body (null for multipart or empty bodies). */
  json: Record<string, unknown> | null
  /** Parsed multipart body (transcriptions). */
  form: FormData | null
  /** Aborts when the client drops the request. */
  signal: AbortSignal
}

type Handler = (request: FakeRequest, attempt: number) => Response | Promise<Response>

export interface FakeIu {
  /** The value for `IU_BASE_URL`. */
  baseUrl: string
  requests: FakeRequest[]
  on(route: FakeRoute, handler: Handler): void
  /** fetch that sends `https://*.replicate.delivery/...` to this server's `delivery` route, everything else as is. */
  fetch: Fetch
  stop(): void
}

function routeOf(path: string): FakeRoute | null {
  if (path === '/openai/v1/chat/completions') return 'chat'
  if (path === '/openai/v1/audio/speech') return 'speech'
  if (path === '/openai/v1/audio/transcriptions') return 'transcriptions'
  if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(path)) return 'gemini'
  if (/^\/gemini\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(path)) return 'geminiStream'
  if (/^\/replicate\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(path)) return 'replicateCreate'
  if (/^\/replicate\/v1\/predictions\/[^/]+$/.test(path)) return 'replicatePoll'
  if (path.startsWith('/delivery/')) return 'delivery'
  return null
}

export function startFakeIu(handlers: Partial<Record<FakeRoute, Handler>> = {}): FakeIu {
  const table: Partial<Record<FakeRoute, Handler>> = { ...handlers }
  const attempts = new Map<FakeRoute, number>()
  const requests: FakeRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const route = routeOf(url.pathname)
      if (!route) return new Response(`no fake route for ${url.pathname}`, { status: 404 })
      const type = req.headers.get('content-type') ?? ''
      let json: Record<string, unknown> | null = null
      let form: FormData | null = null
      if (type.includes('multipart/form-data')) form = await req.formData()
      else {
        const text = await req.text()
        json = text ? (JSON.parse(text) as Record<string, unknown>) : null
      }
      const request: FakeRequest = { route, path: url.pathname, headers: req.headers, json, form, signal: req.signal }
      requests.push(request)
      const attempt = (attempts.get(route) ?? 0) + 1
      attempts.set(route, attempt)
      const handler = table[route]
      if (!handler) return new Response(`no handler for ${route}`, { status: 500 })
      return handler(request, attempt)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  return {
    baseUrl: `${origin}/anthropic`,
    requests,
    on(route, handler) {
      table[route] = handler
      attempts.set(route, 0)
    },
    fetch: (url, init) => {
      const parsed = new URL(url)
      if (parsed.hostname === 'replicate.delivery' || parsed.hostname.endsWith('.replicate.delivery')) {
        return fetch(`${origin}/delivery${parsed.pathname}`, init)
      }
      return fetch(url, init)
    },
    stop: () => {
      void server.stop(true)
    },
  }
}

/** A Gemini unary answer carrying `pcm` as base64 L16. */
export function geminiAudio(pcm: Uint8Array, usage = { promptTokenCount: 10, candidatesTokenCount: 50 }): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/L16;codec=pcm;rate=24000' } },
          ],
        },
      },
    ],
    usageMetadata: usage,
  })
}

/** One SSE `data:` event with audio bytes. */
export const audioEvent = (bytes: number[] | Uint8Array): string =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from(bytes).toString('base64'), mimeType: 'audio/l16;rate=24000' } }] } }] })}\n\n`

/** A streamed body that sends `texts` as separate network chunks. */
export function streamBody(...texts: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const t of texts) c.enqueue(new TextEncoder().encode(t))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** A chat completion whose content is `content` (a prep JSON, usually). */
export function chatAnswer(
  content: string,
  usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 50 },
) {
  return Response.json({ choices: [{ message: { content } }], usage })
}

export function prepAnswer(prep: { lang: string; title?: string; chunks: Array<Record<string, string>> }): Response {
  return chatAnswer(JSON.stringify(prep))
}

export const instantClock: Clock = { now: () => Date.now(), sleep: async () => {} }

export const silentLog: AudioLog = { info: () => {}, warn: () => {}, error: () => {} }

export interface RecordingUsage extends UsagePort {
  events: UsageEvent[]
  /** Resolves with the first request summary once it is recorded (a pcm stream records it when the body ends). */
  settledSummary(): Promise<RequestEvent>
}

export function recordingUsage(): RecordingUsage {
  const events: UsageEvent[] = []
  let resolveSummary!: (event: RequestEvent) => void
  const summary = new Promise<RequestEvent>((resolve) => {
    resolveSummary = resolve
  })
  return {
    events,
    record: (event) => {
      events.push(event)
      if (event.kind === 'request') resolveSummary(event)
    },
    settledSummary: () => summary,
  }
}

/** A config from the defaults, on the fake's base, with overrides. */
export function testConfig(baseUrl: string, overrides: Partial<AudioConfig> = {}): AudioConfig {
  return { ...audioConfig({ IU_API_KEY: 'test-key', IU_BASE_URL: baseUrl }), ...overrides }
}

export function testDeps(
  iu: FakeIu,
  overrides: Partial<Omit<AudioDeps, 'config' | 'usage'>> & { config?: Partial<AudioConfig> } = {},
): AudioDeps & { usage: RecordingUsage } {
  const { config, ...rest } = overrides
  return {
    clock: instantClock,
    log: silentLog,
    fetch: iu.fetch,
    ...rest,
    config: testConfig(iu.baseUrl, config),
    usage: recordingUsage(),
  }
}

/** The rejection of `promise` (fails the test when it resolves). */
export async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected a rejection')
}

export const hasFfmpeg = Boolean(Bun.which('ffmpeg')) && Boolean(Bun.which('ffprobe'))

/** `seconds` of a sine tone as a file in `format` (wav, mp3), via ffmpeg. */
export async function toneFile(
  seconds: number,
  opts: { format?: 'wav' | 'mp3' } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const format = opts.format ?? 'wav'
  const proc = Bun.spawn(
    [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=16000:duration=${seconds}`,
      '-ac',
      '1',
      ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '32k'] : []),
      '-f',
      format,
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [bytes, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
  if (code !== 0) throw new Error(`ffmpeg tone failed (${code})`)
  return new Uint8Array(bytes)
}
