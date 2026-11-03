// The fake gateway: one implementation on a real socket, answering like the gateway's paths (IU's layout) so the
// production adapters are tested over HTTP. The union of what the capabilities and the audio lanes need: chat,
// Messages and decision routes, plus speech, transcriptions, Gemini, Replicate and its delivery host.
export type FakeRoute =
  | 'chat'
  | 'messages'
  | 'decide'
  | 'speech'
  | 'transcriptions'
  | 'gemini'
  | 'geminiStream'
  | 'replicateCreate'
  | 'replicatePoll'
  | 'delivery'

export interface RecordedRequest {
  route: FakeRoute
  path: string
  headers: Headers
  /** The parsed JSON body; `{}` for a multipart or empty body. */
  body: Record<string, unknown>
  /** The parsed multipart body (transcriptions); null for a JSON body. */
  form: FormData | null
  /** Aborts when the client drops the request. */
  signal: AbortSignal
}

/** `attempt` counts the earlier requests to this route since its handler was installed: 0 on the first. */
export type Handler = (request: RecordedRequest, attempt: number) => Response | Promise<Response>

export interface FakeGateway {
  /** The value for `AGW_GATEWAY_URL`: the origin. */
  url: string
  requests: RecordedRequest[]
  /** Replaces the handler for `route` and restarts its attempt count. */
  on(route: FakeRoute, handler: Handler): void
  /** fetch that sends `https://*.replicate.delivery/...` to this server's `delivery` route, everything else as is. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  stop(): void
}

function routeOf(path: string): FakeRoute | null {
  if (path === '/openai/v1/chat/completions') return 'chat'
  if (path === '/anthropic/v1/messages') return 'messages'
  if (path === '/decisions/v1/systemone') return 'decide'
  if (path === '/openai/v1/audio/speech') return 'speech'
  if (path === '/openai/v1/audio/transcriptions') return 'transcriptions'
  if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(path)) return 'gemini'
  if (/^\/gemini\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(path)) return 'geminiStream'
  if (/^\/replicate\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(path)) return 'replicateCreate'
  if (/^\/replicate\/v1\/predictions\/[^/]+$/.test(path)) return 'replicatePoll'
  if (path.startsWith('/delivery/')) return 'delivery'
  return null
}

export function startFakeGateway(handlers: Partial<Record<FakeRoute, Handler>> = {}): FakeGateway {
  const table: Partial<Record<FakeRoute, Handler>> = { ...handlers }
  const attempts = new Map<FakeRoute, number>()
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    // Loopback only: on macOS a wildcard bind can share its port number with another process's 127.0.0.1 bind, which
    // then takes this server's loopback traffic (a stray 405 under parallel test files).
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const route = routeOf(url.pathname)
      const handler = route && table[route]
      if (!route || !handler) return new Response(`fake gateway: nothing for ${url.pathname}`, { status: 404 })
      let body: Record<string, unknown> = {}
      let form: FormData | null = null
      if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) form = await req.formData()
      else {
        const text = await req.text()
        if (text) body = JSON.parse(text) as Record<string, unknown>
      }
      const recorded: RecordedRequest = {
        route,
        path: url.pathname,
        headers: req.headers,
        body,
        form,
        signal: req.signal,
      }
      requests.push(recorded)
      const attempt = attempts.get(route) ?? 0
      attempts.set(route, attempt + 1)
      // Never keep-alive: a later fake server can be given this port, and a pooled socket to the stopped one would fail its first request.
      const response = await handler(recorded, attempt)
      const headers = new Headers(response.headers)
      headers.set('connection', 'close')
      return new Response(response.body, { status: response.status, headers })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  return {
    url: origin,
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
    stop: () => void server.stop(true),
  }
}

export function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** One OpenAI-style stream: the text in two deltas, a finish chunk, then the usage-only chunk. */
export function chatStream(text: string, usage: Record<string, unknown> | null, finish = 'stop'): Response {
  const mid = Math.ceil(text.length / 2)
  return sse([
    { model: 'fake', choices: [{ delta: { content: text.slice(0, mid) } }] },
    { choices: [{ delta: { content: text.slice(mid) } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
    ...(usage ? [{ choices: [], usage }] : []),
  ])
}

export function messageResponse(
  text: string,
  usage: Record<string, unknown> | null,
  stopReason = 'end_turn',
): Response {
  return Response.json({
    model: 'fake',
    stop_reason: stopReason,
    content: text ? [{ type: 'text', text }] : [],
    ...(usage ? { usage } : {}),
  })
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

/** A Messages answer carrying `text` (a prep JSON, usually). */
export function messageAnswer(
  text: string,
  usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 50 },
): Response {
  return Response.json({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage,
  })
}

export function prepAnswer(prep: { lang: string; title?: string; chunks: Array<Record<string, string>> }): Response {
  return chatAnswer(JSON.stringify(prep))
}

/** The same prep JSON as a Messages answer: `audio.tts.prep` is the TRIVIAL seat on the `anthropic` wire. */
export function prepMessage(prep: { lang: string; title?: string; chunks: Array<Record<string, string>> }): Response {
  return messageAnswer(JSON.stringify(prep))
}
