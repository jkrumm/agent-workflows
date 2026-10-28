// A fake OpenCode 2.0.32 server for the unit layer: the routes the host uses, with the behaviour measured on the
// real server (README §Measured). Sessions persist to a JSON file on every change, so a "restart" (a new fake on
// the same file) keeps them, and a kill mid-turn leaves what the real store leaves: an incomplete assistant
// message and no idle. Like the real server, nothing resumes by itself after a restart, and a re-posted input id is
// deduped: it schedules a run that idles at once, with no reply.
//
// The model is scripted by the prompt text: `[slow:<ms>]` turn length, `[tool:<name>]` one tool call first,
// `[shell:<ms>]` a running shell tool that only prints, `[json]` a fenced JSON answer, `[fail]` a failed turn.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

type Part = {
  type: 'text' | 'tool'
  text?: string
  id?: string
  name?: string
  state?: {
    status: string
    input: Record<string, unknown>
    content?: { type: string; text: string }[]
    metadata?: Record<string, unknown>
  }
}
type Msg = {
  id: string
  type: string
  time: { created: number; completed?: number }
  metadata?: Record<string, unknown>
  text?: string
  description?: string
  content?: Part[]
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  cost?: number
  model?: { id: string; providerID: string }
  finish?: string
  outcome?: string
  error?: { message: string }
}
type Input = {
  id: string
  type: 'user' | 'synthetic'
  text: string
  metadata?: Record<string, unknown>
  description?: string
}
type Session = {
  id: string
  title: string
  directory: string
  model: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  messages: Msg[]
  inbox: Input[]
}
type State = { sessions: Record<string, Session>; seq: number }

export type FakeOptions = { port?: number; password: string; statePath: string; defaultTurnMs?: number }

export type FakeServer = Awaited<ReturnType<typeof startFake>>

export function startFake(options: FakeOptions) {
  const state: State = existsSync(options.statePath)
    ? (JSON.parse(readFileSync(options.statePath, 'utf8')) as State)
    : { sessions: {}, seq: 0 }
  const running = new Map<string, { timers: Set<ReturnType<typeof setTimeout>>; finish: () => void }>()
  const shells = new Map<string, number>()
  const locations = new Set<string>()
  const requests: string[] = []
  let hung = false
  const turnMs = options.defaultTurnMs ?? 50

  const save = () => writeFileSync(options.statePath, JSON.stringify(state))
  const id = (prefix: string) => `${prefix}_fake${String(++state.seq).padStart(8, '0')}`
  const now = () => Date.now()
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const notFound = (sessionID: string) =>
    json({ _tag: 'SessionNotFoundError', sessionID, message: `Session not found: ${sessionID}` }, 404)

  function exists(s: Session, msgId: string) {
    return s.messages.some((m) => m.id === msgId) || s.inbox.some((m) => m.id === msgId)
  }

  function admit(s: Session, input: Input): { duplicate: boolean } {
    if (exists(s, input.id)) return { duplicate: true }
    s.inbox.push(input)
    save()
    return { duplicate: false }
  }

  function promptText(s: Session): string {
    const prompt = [...s.messages].reverse().find((m) => m.type === 'user')
    return prompt?.text ?? ''
  }

  function schedule(s: Session, fn: () => void, ms: number) {
    const run = running.get(s.id)
    const timer = setTimeout(() => {
      run?.timers.delete(timer)
      fn()
    }, ms)
    run?.timers.add(timer)
  }

  /** One execution: drain the inbox into messages, answer, repeat while input keeps arriving, then idle. */
  function execute(s: Session) {
    if (running.has(s.id)) return
    const finish = () => {
      running.delete(s.id)
      if (s.inbox.length > 0) return execute(s)
      s.messages.push({ id: id('msg'), type: 'idle', time: { created: now() }, outcome: 'succeeded' })
      save()
    }
    running.set(s.id, { timers: new Set(), finish })
    if (s.inbox.length === 0) {
      // A duplicate input on an idle session: the real server runs and idles at once, with no reply.
      return schedule(s, finish, 1)
    }
    const inputs = s.inbox.splice(0)
    for (const input of inputs) {
      s.messages.push({
        id: input.id,
        type: input.type,
        time: { created: now() },
        text: input.text,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.description ? { description: input.description } : {}),
      })
    }
    const last = inputs.at(-1) as Input
    const prompt = promptText(s)
    const ms = Number(/\[slow:(\d+)\]/.exec(prompt)?.[1] ?? turnMs)
    const tool = /\[tool:([a-z]+)\]/.exec(prompt)?.[1]
    const shell = Number(/\[shell:(\d+)\]/.exec(prompt)?.[1] ?? 0)
    const usedTool = s.messages.some((m) => m.content?.some((p) => p.type === 'tool'))
    const reply: Msg = { id: id('msg'), type: 'assistant', time: { created: now() }, model: s.model, content: [] }
    s.messages.push(reply)
    save()
    const tokens = { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 20 } }

    if ((tool || shell) && !usedTool) {
      const part: Part = {
        type: 'tool',
        id: id('call'),
        name: tool ?? 'shell',
        state: { status: 'running', input: { command: 'ls' }, metadata: {} },
      }
      if (shell) {
        const shellID = id('sh')
        ;(part.state as NonNullable<Part['state']>).metadata = { shellID }
        shells.set(shellID, 0)
        const grow = setInterval(() => shells.set(shellID, (shells.get(shellID) ?? 0) + 10), 50)
        running.get(s.id)?.timers.add(grow)
        schedule(s, () => clearInterval(grow), shell)
      }
      reply.content?.push(part)
      save()
      schedule(
        s,
        () => {
          part.state = { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.txt' }] }
          Object.assign(reply, { finish: 'tool-calls', tokens, cost: 0.001, time: { ...reply.time, completed: now() } })
          s.inbox.push({ id: id('msg'), type: 'synthetic', text: 'tool result' })
          save()
          running.get(s.id)?.finish()
        },
        Math.max(ms, shell),
      )
      return
    }

    schedule(
      s,
      () => {
        if (/\[fail\]/.test(prompt)) {
          Object.assign(reply, { finish: 'error', time: { ...reply.time, completed: now() } })
          s.messages.push({
            id: id('msg'),
            type: 'idle',
            time: { created: now() },
            outcome: 'failed',
            error: { message: 'provider said no' },
          })
          running.delete(s.id)
          save()
          return
        }
        const resumed = last.type === 'synthetic' && last.metadata ? 'resumed: ' : ''
        const text = /\[json\]/.test(prompt)
          ? `Here it is:\n\`\`\`json\n${JSON.stringify({ ok: true, inputs: s.messages.filter((m) => m.type === 'user').length })}\n\`\`\``
          : `${resumed}echo: ${last.type === 'user' ? last.text : prompt}`
        reply.content = [{ type: 'text', text }]
        Object.assign(reply, { finish: 'stop', tokens, cost: 0.001, time: { ...reply.time, completed: now() } })
        save()
        running.get(s.id)?.finish()
      },
      ms,
    )
  }

  function interrupt(s: Session): boolean {
    const run = running.get(s.id)
    if (!run) return false
    for (const t of run.timers) clearTimeout(t)
    running.delete(s.id)
    const reply = [...s.messages].reverse().find((m) => m.type === 'assistant')
    if (reply) reply.time.completed = now()
    s.messages.push({ id: id('msg'), type: 'idle', time: { created: now() }, outcome: 'interrupted' })
    save()
    return true
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (hung) return new Promise<Response>(() => {})
      const url = new URL(req.url)
      const path = url.pathname
      requests.push(`${req.method} ${path}`)
      if (req.headers.get('authorization') !== `Basic ${btoa(`opencode:${options.password}`)}`) {
        return json({ _tag: 'UnauthorizedError', message: 'Authentication required' }, 401)
      }
      const body =
        req.method === 'GET' || req.method === 'DELETE'
          ? {}
          : ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      const directory = url.searchParams.get('location[directory]')

      if (path === '/api/info') return json({ version: '2.0.32', pid: process.pid, urls: [], paths: { tmp: '/tmp' } })
      if (path === '/api/session/active') {
        return json({ data: Object.fromEntries([...running.keys()].map((k) => [k, { type: 'running' }])) })
      }
      if (path === '/api/location' && directory) {
        locations.add(directory)
        return json({ directory, project: { id: 'p', directory } })
      }
      if (path === '/api/debug/location' && req.method === 'GET')
        return json([...locations].map((d) => ({ directory: d })))
      if (path === '/api/debug/location' && req.method === 'DELETE' && directory) {
        locations.delete(directory)
        return new Response(null, { status: 204 })
      }
      if (path === '/api/session' && req.method === 'POST') {
        const loc = (body.location as { directory: string }).directory
        locations.add(loc)
        const s: Session = {
          id: id('ses'),
          title: String(body.title ?? ''),
          directory: loc,
          model: body.model as Session['model'],
          metadata: body.metadata as Record<string, unknown>,
          messages: [],
          inbox: [],
        }
        state.sessions[s.id] = s
        save()
        return json({ data: { id: s.id, location: { directory: loc }, model: s.model, metadata: s.metadata } })
      }
      const shellMatch = /^\/api\/shell\/([^/]+)\/output$/.exec(path)
      if (shellMatch) return json({ data: { size: shells.get(shellMatch[1] as string) ?? 0 } })

      const m = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(path)
      if (!m) return json({ message: 'no route' }, 404)
      const s = state.sessions[m[1] as string]
      if (!s) return notFound(m[1] as string)
      const tail = m[2] ?? ''
      if (tail === '' && req.method === 'GET') return json({ data: { id: s.id, title: s.title, metadata: s.metadata } })
      if (tail === '/message') {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const cursor = url.searchParams.get('cursor')
        const order = cursor
          ? (JSON.parse(atob(cursor)) as { order: string }).order
          : (url.searchParams.get('order') ?? 'desc')
        const list = order === 'asc' ? s.messages : [...s.messages].reverse()
        const start = cursor ? (JSON.parse(atob(cursor)) as { at: number }).at : 0
        const data = list.slice(start, start + limit)
        return json({ data, cursor: { next: btoa(JSON.stringify({ at: start + data.length, order })) } })
      }
      if (tail === '/inbox') return json({ data: s.inbox.map((i) => ({ id: i.id })) })
      if (tail === '/prompt' || tail === '/synthetic') {
        const input: Input = {
          id: String(body.id ?? id('msg')),
          type: tail === '/prompt' ? 'user' : 'synthetic',
          text: String(body.text ?? ''),
          ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
          ...(body.description ? { description: String(body.description) } : {}),
        }
        admit(s, input)
        if (body.resume !== false) execute(s)
        return json({ data: { id: input.id, sessionID: s.id, type: input.type, payload: { text: input.text } } })
      }
      if (tail === '/interrupt') return json({ interrupted: interrupt(s) })
      return json({ message: 'no route' }, 404)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    requests,
    state,
    locations,
    /** Stop answering anything, `/api/info` included, and stop every running turn (a wedged server). */
    hang() {
      hung = true
      for (const run of running.values()) for (const t of run.timers) clearTimeout(t)
    },
    /** A kill: the listener goes, running turns stop where they are (nothing more is persisted). */
    stop() {
      for (const run of running.values()) for (const t of run.timers) clearTimeout(t)
      running.clear()
      void server.stop(true)
    },
    count: (route: string) => requests.filter((r) => r === route).length,
  }
}
