// Thin HTTP client over the OpenCode 2.0.32 server API (`opencode serve`). Shapes are the ones measured against the
// running 2.0.32 server (README §Measured); only the fields the host reads are typed, everything else passes through.
// A response body is never logged: `GET /api/config` echoes the provider key and a message can echo anything.

/** Where the server listens and how to authenticate. HTTP Basic, the username must be `opencode`. */
export type Endpoint = { baseUrl: string; password: string }

export type ToolState = {
  status?: string
  input?: Record<string, unknown>
  content?: { type?: string; text?: string }[]
  error?: { message?: string } | string
  metadata?: Record<string, unknown>
}

export type ContentPart = { type?: string; id?: string; name?: string; text?: string; state?: ToolState }

/** One entry of `GET /api/session/:id/message` (`data[]`). */
export type Message = {
  id: string
  type: string
  metadata?: { agw?: { kind?: string } } & Record<string, unknown>
  time?: { created?: number; completed?: number }
  text?: string
  content?: ContentPart[]
  finish?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  model?: { id?: string; providerID?: string }
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  error?: { message?: string } | string
}

export type ModelRef = { providerID: string; id: string; variant?: string }

/** One permission rule; the last matching rule wins (measured on 2.0.25 by agent-gateway). */
export type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' }

export type SessionCreate = {
  /** Client-chosen id (`ses…`); a second create with the same id returns the first session. */
  id?: string
  permissions?: PermissionRule[]
  title: string
  location: { directory: string }
  model: ModelRef
  metadata?: Record<string, unknown>
}

export type InputBody = {
  id: string
  text: string
  metadata?: Record<string, unknown>
  delivery?: 'steer' | 'queue'
}

/** The server answered with a non-2xx status. Carries the status and route, never the body. */
export class OpenCodeHttpError extends Error {
  override name = 'OpenCodeHttpError'
  constructor(
    readonly status: number,
    readonly route: string,
  ) {
    super(`opencode server answered HTTP ${status} on ${route}`)
  }
}

/** No answer: refused, reset or the request's hang guard. The wait loop treats it as transient. */
export class OpenCodeUnreachable extends Error {
  override name = 'OpenCodeUnreachable'
}

export type ClientOptions = {
  /** Hang guard for one short request (plain local HTTP, never an agent run). Default 30 s. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
}

/** v2 caps `limit` at 200. */
const PAGE_LIMIT = 200

export type OpenCodeClient = ReturnType<typeof createClient>

export function createClient(endpoint: () => Endpoint, options: ClientOptions = {}) {
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const fetchImpl = options.fetch ?? fetch

  async function call(
    method: string,
    path: string,
    init: { body?: unknown; timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const { baseUrl, password } = endpoint()
    const signals = [AbortSignal.timeout(init.timeoutMs ?? timeoutMs), ...(init.signal ? [init.signal] : [])]
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${btoa(`opencode:${password}`)}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      if (init.signal?.aborted) throw init.signal.reason
      const route = `${method} ${path.split('?')[0]}`
      throw new OpenCodeUnreachable(`opencode server unreachable on ${route}: ${(err as Error).name}`, { cause: err })
    }
  }

  async function json<T>(res: Response, route: string): Promise<T> {
    if (!res.ok) {
      await res.body?.cancel()
      throw new OpenCodeHttpError(res.status, route)
    }
    return (await res.json()) as T
  }

  async function ok(res: Response, route: string): Promise<void> {
    await res.body?.cancel()
    if (!res.ok) throw new OpenCodeHttpError(res.status, route)
  }

  const session = (id: string, tail = '') => `/api/session/${encodeURIComponent(id)}${tail}`
  const locationQuery = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`

  return {
    /** `GET /api/info`. Needs auth on 2.0.32 (a 401 without it), so it also proves the password. */
    async info(init: { timeoutMs?: number } = {}): Promise<{ version: string; pid: number }> {
      return json(await call('GET', '/api/info', init), 'GET /api/info')
    },

    async createSession(body: SessionCreate, headers?: Record<string, string>): Promise<{ id: string }> {
      const res = await call('POST', '/api/session', { body, headers })
      return (await json<{ data: { id: string } }>(res, 'POST /api/session')).data
    },

    /** `PATCH /api/session/{id}`: replaces the session's permissions (measured on 2.0.32, `test/live-permissions.test.ts`). */
    async updateSession(
      id: string,
      body: { permissions: PermissionRule[] },
      headers?: Record<string, string>,
    ): Promise<void> {
      await ok(await call('PATCH', session(id), { body, headers }), 'PATCH /api/session/{id}')
    },

    /** The session, or null when the server does not know it (404). */
    async getSession(
      id: string,
      headers?: Record<string, string>,
    ): Promise<{ id: string; location: { directory: string }; permissions?: PermissionRule[] } | null> {
      const res = await call('GET', session(id), { headers })
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      return (
        await json<{ data: { id: string; location: { directory: string }; permissions?: PermissionRule[] } }>(
          res,
          'GET /api/session/{id}',
        )
      ).data
    },

    /** The newest `limit` messages, newest first: one request, the incremental read. */
    async recentMessages(id: string, limit: number, headers?: Record<string, string>): Promise<Message[]> {
      const res = await call('GET', session(id, `/message?order=desc&limit=${limit}`), { headers })
      return (await json<{ data: Message[] }>(res, 'GET /api/session/{id}/message')).data
    },

    /** Every message, oldest first: `order=asc`, then `cursor=<next>` until a page is empty or has no cursor. */
    async messages(id: string, headers?: Record<string, string>): Promise<Message[]> {
      const out: Message[] = []
      let path = session(id, `/message?order=asc&limit=${PAGE_LIMIT}`)
      for (;;) {
        const page = await json<{ data: Message[]; cursor?: { next?: string | null } }>(
          await call('GET', path, { headers }),
          'GET /api/session/{id}/message',
        )
        out.push(...page.data)
        const next = page.cursor?.next
        if (page.data.length === 0 || !next) return out
        path = session(id, `/message?cursor=${encodeURIComponent(next)}&limit=${PAGE_LIMIT}`)
      }
    },

    /** Admitted inputs not yet projected into messages (`GET /api/session/:id/inbox`). */
    async inbox(id: string, headers?: Record<string, string>): Promise<{ id: string }[]> {
      const res = await call('GET', session(id, '/inbox'), { headers })
      return (await json<{ data: { id: string }[] }>(res, 'GET /api/session/{id}/inbox')).data
    },

    /** Session ids with a running execution. */
    async active(headers?: Record<string, string>): Promise<Set<string>> {
      const res = await call('GET', '/api/session/active', { headers })
      return new Set(Object.keys((await json<{ data: Record<string, unknown> }>(res, 'GET /api/session/active')).data))
    },

    /** A user message. With a client `id` the server dedupes: a second post returns the first admission. */
    async prompt(id: string, body: InputBody, headers?: Record<string, string>): Promise<void> {
      await ok(await call('POST', session(id, '/prompt'), { body, headers }), 'POST /api/session/{id}/prompt')
    },

    /** A synthetic (non-user) input that schedules execution; deduped by `id` like a prompt. */
    async synthetic(id: string, body: InputBody & { description?: string }, headers?: Record<string, string>) {
      await ok(await call('POST', session(id, '/synthetic'), { body, headers }), 'POST /api/session/{id}/synthetic')
    },

    /** `{ interrupted: false }` on an idle session; 404 for an unknown one. */
    async interrupt(id: string, headers?: Record<string, string>): Promise<{ interrupted: boolean }> {
      return json(await call('POST', session(id, '/interrupt'), { headers }), 'POST /api/session/{id}/interrupt')
    },

    /** Resolves (and boots) a location: the warm-up. */
    async location(directory: string): Promise<void> {
      await ok(await call('GET', `/api/location?${locationQuery(directory)}`), 'GET /api/location')
    },

    /** Disposes a location's cached services; its next use boots them fresh (re-reads AGENTS.md, skills, config). */
    async evictLocation(directory: string): Promise<void> {
      await ok(await call('DELETE', `/api/debug/location?${locationQuery(directory)}`), 'DELETE /api/debug/location')
    },

    async loadedLocations(): Promise<string[]> {
      const res = await call('GET', '/api/debug/location')
      return (await json<{ directory: string }[]>(res, 'GET /api/debug/location')).map((l) => l.directory)
    },

    /** Bytes a running shell tool has printed so far; grows live. The idle watchdog's signal for a long command. */
    async shellOutputSize(shellId: string, directory: string): Promise<number> {
      const res = await call(
        'GET',
        `/api/shell/${encodeURIComponent(shellId)}/output?${locationQuery(directory)}&limit=1`,
      )
      return (await json<{ data: { size: number } }>(res, 'GET /api/shell/{id}/output')).data.size
    },
  }
}
