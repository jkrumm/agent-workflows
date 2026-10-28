// A fake IU endpoint on a real socket, so the production adapters are tested over HTTP.
export interface RecordedRequest {
  path: string
  headers: Headers
  body: Record<string, unknown>
}

type Handler = (request: RecordedRequest, attempt: number) => Response | Promise<Response>

export interface FakeIuServer {
  /** The value for `IU_BASE_URL`. */
  baseUrl: string
  requests: RecordedRequest[]
  /** Replace the handler for `chat` (`/openai/v1/chat/completions`), `messages` (`/anthropic/v1/messages`) or `decide` (`/decisions/v1/systemone`). */
  on(route: 'chat' | 'messages' | 'decide', handler: Handler): void
  stop(): void
}

const ROUTES = {
  '/openai/v1/chat/completions': 'chat',
  '/anthropic/v1/messages': 'messages',
  '/decisions/v1/systemone': 'decide',
} as const

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

export function startFakeIu(handlers: Partial<Record<'chat' | 'messages' | 'decide', Handler>> = {}): FakeIuServer {
  const table = { ...handlers }
  const attempts = { chat: 0, messages: 0, decide: 0 }
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    // Loopback only: on macOS a wildcard bind can share its port number with another process's 127.0.0.1 bind, which
    // then takes this server's loopback traffic (a stray 405 under parallel test files).
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const route = ROUTES[path as keyof typeof ROUTES]
      const handler = route && table[route]
      if (!route || !handler) return new Response(`fake IU: nothing for ${path}`, { status: 404 })
      const recorded: RecordedRequest = {
        path,
        headers: req.headers,
        body: (await req.json()) as Record<string, unknown>,
      }
      requests.push(recorded)
      // Never keep-alive: a later fake server can be given this port, and a pooled socket to the stopped one would fail its first request.
      const response = await handler(recorded, attempts[route]++)
      const headers = new Headers(response.headers)
      headers.set('connection', 'close')
      return new Response(response.body, { status: response.status, headers })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
    requests,
    on: (route, handler) => {
      table[route] = handler
    },
    stop: () => void server.stop(true),
  }
}
