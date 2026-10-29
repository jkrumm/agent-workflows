import type { Json } from './json.ts'
import { raceAbort } from './scope.ts'
import type { AgentFollowUpSpec, AgentHost, AgentOpenSpec, AgentResult, AgentWaitOptions } from './types.ts'

/** One fake session; the script drives it like a model would. */
export class FakeSession {
  readonly steers: string[] = []
  prompted = false
  aborted = false
  private readonly abortController = new AbortController()
  private waiter: AgentWaitOptions | null = null
  private steerListeners: ((text: string) => void)[] = []
  private markAttached!: () => void
  /** Resolves once a step has attached its waiter (first `wait`); `tool`/`progress` before that reach no hook. */
  readonly attached = new Promise<void>((resolve) => {
    this.markAttached = resolve
  })
  result: Promise<AgentResult> | null = null
  /** The text `prompt` sent: the open spec's prompt, or a follow-up turn's own text. */
  sent: string | null = null

  constructor(
    readonly id: string,
    readonly spec: AgentOpenSpec,
    /** Set on a follow-up turn (`followUp`): the session it continues, whose history it shares. */
    readonly turnOf: FakeSession | null = null,
  ) {}

  /** The session this one (a turn, or a turn of a turn) continues; itself for a first turn. */
  get root(): FakeSession {
    return this.turnOf ? this.turnOf.root : this
  }

  /** Aborted by `host.abort`. */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  /** A new message: feeds the step's idle watchdog when someone waits. */
  progress() {
    this.waiter?.onProgress()
  }

  async tool(tool: string, input: Json, output: Json) {
    const callId = `${this.id}:${tool}:${crypto.randomUUID()}`
    await this.waiter?.onTool({ phase: 'pre', callId, tool, input })
    await this.waiter?.onTool({ phase: 'post', callId, tool, input, output })
  }

  /** Resolves with the next steer text. */
  nextSteer(): Promise<string> {
    return new Promise((resolve) => this.steerListeners.push(resolve))
  }

  /** Sleeps `ms`, sending a progress event every `everyMs` (if given); rejects on abort. */
  async sleep(ms: number, everyMs?: number) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      await raceAbort(Bun.sleep(Math.min(everyMs ?? ms, until - Date.now())), this.signal)
      if (everyMs) this.progress()
    }
  }

  attach(options: AgentWaitOptions | null) {
    this.waiter = options
    if (options) this.markAttached()
  }

  receiveSteer(text: string) {
    this.steers.push(text)
    const listeners = this.steerListeners.splice(0)
    for (const listener of listeners) listener(text)
  }

  abort() {
    this.aborted = true
    this.abortController.abort(new Error(`session ${this.id} aborted`))
  }
}

export type FakeScript = (session: FakeSession) => Promise<AgentResult>

export type FakeHostEvent =
  | { op: 'open'; sessionId: string }
  | { op: 'prompt'; sessionId: string; outcome: 'sent' | 'noop' }
  | { op: 'steer'; sessionId: string; text: string; signalId?: string }
  | { op: 'abort'; sessionId: string }
  | { op: 'followUp'; sessionId: string; turnId: string; attempt: number }

/**
 * In-memory `AgentHost` for tests. A session runs its script from the first prompt, whether or not anyone
 * waits, like a real server whose client went away; a second prompt is a recorded no-op.
 */
export class FakeAgentHost implements AgentHost {
  readonly sessions = new Map<string, FakeSession>()
  readonly events: FakeHostEvent[] = []
  private seq = 0

  constructor(
    private readonly script: FakeScript = async (s) => ({ output: { echo: s.turnOf ? s.sent : s.spec.prompt } }),
  ) {}

  async open(spec: AgentOpenSpec): Promise<Json> {
    const id = `ses_${++this.seq}`
    this.sessions.set(id, new FakeSession(id, spec))
    this.events.push({ op: 'open', sessionId: id })
    return { sessionId: id }
  }

  async prompt(handle: Json, prompt?: string): Promise<void> {
    const session = this.session(handle)
    if (session.prompted) {
      this.events.push({ op: 'prompt', sessionId: session.id, outcome: 'noop' })
      return
    }
    session.prompted = true
    session.sent = prompt ?? session.spec.prompt
    this.events.push({ op: 'prompt', sessionId: session.id, outcome: 'sent' })
    session.result = this.script(session)
    session.result.catch(() => {})
  }

  async wait(handle: Json, options: AgentWaitOptions): Promise<AgentResult> {
    const session = this.session(handle)
    if (!session.result) throw new Error(`session ${session.id} was never prompted`)
    session.attach(options)
    try {
      return await raceAbort(session.result, options.signal)
    } finally {
      session.attach(null)
    }
  }

  async steer(handle: Json, text: string, options?: { signalId?: string }): Promise<void> {
    const session = this.session(handle)
    this.events.push({ op: 'steer', sessionId: session.id, text, signalId: options?.signalId })
    session.receiveSteer(text)
  }

  async abort(handle: Json): Promise<void> {
    const session = this.session(handle)
    this.events.push({ op: 'abort', sessionId: session.id })
    session.abort()
  }

  /** A follow-up turn: its own fake session (`turnOf` the one it continues), run by the script on `prompt`. */
  async followUp(handle: Json, spec: AgentFollowUpSpec): Promise<Json> {
    const parent = this.session(handle)
    if (!parent.result) throw new Error(`session ${parent.id} was never prompted`)
    const id = `${parent.root.id}/t${++this.seq}`
    this.sessions.set(id, new FakeSession(id, { ...parent.spec, ...spec, prompt: '' }, parent))
    this.events.push({ op: 'followUp', sessionId: parent.id, turnId: id, attempt: spec.attempt })
    return { sessionId: id }
  }

  count(op: FakeHostEvent['op'], outcome?: 'sent' | 'noop'): number {
    return this.events.filter((e) => e.op === op && (!outcome || ('outcome' in e && e.outcome === outcome))).length
  }

  private session(handle: Json): FakeSession {
    const id = (handle as { sessionId?: string } | null)?.sessionId
    const session = id ? this.sessions.get(id) : undefined
    if (!session) throw new Error(`unknown session ${JSON.stringify(handle)}`)
    return session
  }
}
