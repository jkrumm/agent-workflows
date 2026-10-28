import { usageFromOpenCodeMessages } from '@agent-workflows/middleware'
import { costFromUsage, type Rate, type RouteId } from '@agent-workflows/routes'
import {
  type AgentHost,
  type AgentOpenSpec,
  type AgentResult,
  type AgentWaitOptions,
  type Json,
  type Logger,
  type Usage,
  WorkflowError,
} from '@agent-workflows/runtime'
import {
  createClient,
  type Endpoint,
  type Message,
  type OpenCodeClient,
  OpenCodeHttpError,
  OpenCodeUnreachable,
  type PermissionRule,
} from './client.ts'
import { modelRef, rateFor } from './config.ts'
import {
  type AgentDefinition,
  compileLocation,
  pruneLocations,
  touchLocation,
  WarmCache,
  type WarmCacheOptions,
} from './locations.ts'
import {
  activityFingerprint,
  finalText,
  inputId,
  type Outcome,
  Persisting,
  parseStructured,
  promptIndex,
  SessionReader,
  sessionIdFor,
  sessionState,
  steerId,
  type ToolPart,
  toolParts,
} from './session.ts'

type Env = Record<string, string | undefined>

/** What the host needs from a server: `OpenCodeServer`, or a fixed endpoint in tests. */
export type ServerPort = {
  endpoint(): Endpoint
  ready(signal?: AbortSignal): Promise<void>
  onRestart?(listener: () => void): void
}

export type OpenCodeHostOptions = {
  server: ServerPort
  agents: readonly AgentDefinition[]
  /** Where locations are compiled. Default `~/.local/state/agent-workflows`. */
  stateDir?: string
  /** How often `wait` reads the session. Default 1 s. */
  pollIntervalMs?: number
  /** A session must look cut off (or unprompted) this long before the host acts on it. Default 3 s. */
  cutoffGraceMs?: number
  locations?: WarmCacheOptions & {
    tickMs?: number
    /** Unused hash directories older than this are pruned. Default 24 h (covers a re-attach after a crash). */
    retentionMs?: number
  }
  /** W3C `traceparent` of the step span (`Telemetry.traceparent`), sent on every request of the step. */
  traceparent?: (runId: string, stepId: string) => string | undefined
  /** Route resolution (`AGW_ROUTES`). Default `process.env`. */
  env?: Env
  requestTimeoutMs?: number
  logger?: Logger
}

/** The journaled handle: plain JSON, nothing process-local. */
export type OpenCodeHandle = {
  v: 1
  sessionId: string
  directory: string
  agent: string
  route: RouteId
  model: string
  output: 'json' | 'text'
  runId: string
  stepId: string
}

type Snapshot = { messages: Message[]; active: boolean; pending: boolean }

const TOOL_TEXT_LIMIT = 10_000
/** Above this many prompt tokens in one call the vendor bills a higher tier (routes `LONG_PROMPT_TOKENS`). */
const LONG_PROMPT_TOKENS = 100_000
/** Session generations tried for one step key before giving up (one per failed attempt). */
const MAX_GENERATIONS = 100

const RESUME_TEXT =
  'The previous turn was cut off when the agent server restarted before it finished. Continue the task from ' +
  'where it stopped and complete it. Do not repeat tool calls whose results are already above.'

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
}

function asHandle(handle: Json): OpenCodeHandle {
  const h = handle as Partial<OpenCodeHandle> | null
  if (!h || typeof h !== 'object' || h.v !== 1 || typeof h.sessionId !== 'string') {
    throw new WorkflowError('error', 'not an OpenCode host handle')
  }
  return h as OpenCodeHandle
}

const transient = (err: unknown) =>
  err instanceof OpenCodeUnreachable ||
  (err instanceof OpenCodeHttpError && (err.status >= 500 || [408, 425, 429].includes(err.status)))

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The host's rules first (shell denied unless the agent opts in), the agent's own after them: last match wins. */
export function sessionPermissions(def: AgentDefinition): PermissionRule[] {
  return [
    { action: 'shell', resource: '*', effect: def.permissions?.shell ? 'allow' : 'deny' },
    ...(def.permissions?.rules ?? []),
  ]
}

/**
 * The runtime's `AgentHost` on one OpenCode server (concept §3, §8). One session per agent step attempt, in the
 * agent's compiled location; its id is derived from the step key, so a re-open after a crash finds it. Every input
 * the host writes carries a deterministic message id and `metadata.agw.kind`, so `prompt` is exact and a re-sent
 * input is deduped by the server too. `wait` polls the session until it is idle and re-attaches across server
 * restarts: a turn the server lost mid-way is resumed with one appended synthetic note.
 */
export class OpenCodeHost implements AgentHost {
  private readonly client: OpenCodeClient
  private readonly agents: Map<string, AgentDefinition>
  private readonly cache: WarmCache
  private readonly pollMs: number
  private readonly cutoffGraceMs: number
  private readonly env: Env
  private readonly logger: Logger
  private readonly timer: ReturnType<typeof setInterval>
  /** Hash directory per agent compiled by this process: always kept by pruning. */
  private readonly current = new Map<string, string>()

  constructor(private readonly options: OpenCodeHostOptions) {
    this.client = createClient(() => options.server.endpoint(), { requestTimeoutMs: options.requestTimeoutMs })
    this.agents = new Map(options.agents.map((a) => [a.name, a]))
    this.pollMs = options.pollIntervalMs ?? 1_000
    this.cutoffGraceMs = options.cutoffGraceMs ?? 3_000
    this.env = options.env ?? process.env
    this.logger = options.logger ?? consoleLogger
    this.cache = new WarmCache(
      { warm: (dir) => this.client.location(dir), evict: (dir) => this.client.evictLocation(dir) },
      { logger: this.logger, ...options.locations },
    )
    options.server.onRestart?.(() => this.cache.reset())
    this.timer = setInterval(() => {
      this.maintain().catch((err: unknown) => {
        this.logger.warn('opencode location maintenance failed', { error: (err as Error).name })
      })
    }, options.locations?.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  /** Locations the server currently holds warm for this host. */
  warmLocations(): string[] {
    return this.cache.warmLocations()
  }

  /** Evicts idle locations and prunes unused hash directories now (the timer does it every `locations.tickMs`). */
  async maintain(): Promise<string[]> {
    await this.cache.tick()
    const keep = new Set([...this.cache.known(), ...this.current.values()])
    for (const id of await this.client.active()) {
      const session = await this.client.getSession(id).catch(() => null)
      if (session) keep.add(session.location.directory)
    }
    return pruneLocations({
      stateDir: this.options.stateDir,
      keep,
      retentionMs: this.options.locations?.retentionMs ?? 24 * 3_600_000,
    })
  }

  close(): void {
    clearInterval(this.timer)
  }

  async open(spec: AgentOpenSpec): Promise<Json> {
    const def = this.agents.get(spec.agent)
    if (!def)
      throw new WorkflowError('error', `unknown agent "${spec.agent}" (known: ${[...this.agents.keys()].join(', ')})`)
    const options = (spec.options ?? {}) as { route?: RouteId; output?: string }
    const routeId = options.route ?? def.route
    if (!routeId) throw new WorkflowError('error', `agent "${spec.agent}" has no route and the step names none`)
    const { route, model } = modelRef(routeId, this.env)
    const location = compileLocation(def, { stateDir: this.options.stateDir })
    this.current.set(def.name, location.directory)
    touchLocation(location.directory)
    await this.options.server.ready()
    const release = await this.cache.use(location.directory, { changed: location.changed })
    release()
    const headers = this.headers(spec.runId, spec.stepId)
    const sessionId = await this.sessionFor(spec.key, location.directory, headers)
    // A second create with the same id returns the first session (measured), so a crash right here is harmless.
    await this.client.createSession(
      {
        id: sessionId,
        // A title set at create skips OpenCode's background title call (billed to the session otherwise).
        title: `agw ${spec.runId}:${spec.stepId}`,
        location: { directory: location.directory },
        model,
        permissions: sessionPermissions(def),
        metadata: { agw: { key: spec.key, agent: def.name, route: routeId, locationHash: location.hash } },
      },
      headers,
    )
    const handle: OpenCodeHandle = {
      v: 1,
      sessionId,
      directory: location.directory,
      agent: def.name,
      route: routeId,
      model: route.model,
      output: options.output === 'json' ? 'json' : 'text',
      runId: spec.runId,
      stepId: spec.stepId,
    }
    return handle
  }

  /** Reads the session first and sends only when the prompt is not there (messages or inbox); the id dedupes too. */
  async prompt(handle: Json, prompt: string): Promise<void> {
    const h = asHandle(handle)
    const headers = this.headers(h.runId, h.stepId)
    if (await this.prompted(h.sessionId, headers)) return
    const id = inputId(h.sessionId, 'prompt')
    await this.client.prompt(h.sessionId, { id, text: prompt, metadata: { agw: { kind: 'prompt' } } }, headers)
  }

  async wait(handle: Json, options: AgentWaitOptions): Promise<AgentResult> {
    const h = asHandle(handle)
    const { signal } = options
    const promptId = inputId(h.sessionId, 'prompt')
    const headers = this.headers(h.runId, h.stepId)
    const reader = new SessionReader({
      all: () => this.client.messages(h.sessionId, headers),
      recent: (limit) => this.client.recentMessages(h.sessionId, limit, headers),
    })
    const tools = new Map<string, 'pre' | 'post'>()
    const shells = new Map<string, number>()
    const cutoff = new Persisting()
    const unprompted = new Persisting()
    let release: (() => void) | null = null
    let fingerprint: string | null = null
    try {
      for (;;) {
        signal.throwIfAborted()
        await this.options.server.ready(signal)
        release ??= await this.cache.use(h.directory).catch((err: unknown) => {
          if (!transient(err)) throw err
          return null
        })
        const snap = await this.read(h, reader, headers, signal)
        if (snap) {
          const next = activityFingerprint(snap.messages)
          if (fingerprint !== null && next !== fingerprint) options.onProgress()
          fingerprint = next
          await this.reportTools(toolParts(snap.messages, promptId), tools, options)
          if (await this.shellGrew(h, snap.messages, shells)) options.onProgress()

          const state = sessionState(snap.messages, { promptId, active: snap.active, pending: snap.pending })
          if (unprompted.check(state.kind === 'unprompted', this.cutoffGraceMs)) {
            throw new WorkflowError('error', `opencode session ${h.sessionId} holds no prompt; wait before prompt`)
          }
          if (state.kind === 'done') return await this.finish(h, reader, promptId, state, signal)
          if (state.kind === 'cutoff' && cutoff.check(true, this.cutoffGraceMs)) {
            await this.resume(h, state.lastId)
            cutoff.reset()
          } else if (state.kind !== 'cutoff') {
            cutoff.reset()
          }
        }
        await abortableSleep(this.pollMs, signal)
      }
    } finally {
      release?.()
    }
  }

  /**
   * Appends a user message (`delivery: steer`); history is never rewritten. Keyed by the runtime's signal id, so a
   * re-delivered steer is a no-op and two identical steers stay two.
   */
  async steer(handle: Json, text: string, options: { signalId?: string } = {}): Promise<void> {
    const h = asHandle(handle)
    await this.client.prompt(
      h.sessionId,
      { id: steerId(h.sessionId, options.signalId), text, delivery: 'steer', metadata: { agw: { kind: 'steer' } } },
      this.headers(h.runId, h.stepId),
    )
  }

  /** Interrupts the running turn. Idempotent: an idle session answers `interrupted: false`, a gone one 404. */
  async abort(handle: Json): Promise<void> {
    const h = asHandle(handle)
    try {
      await this.client.interrupt(h.sessionId, this.headers(h.runId, h.stepId))
    } catch (err) {
      if (err instanceof OpenCodeHttpError && err.status === 404) return
      throw err
    }
  }

  private headers(runId: string, stepId: string): Record<string, string> | undefined {
    const traceparent = this.options.traceparent?.(runId, stepId)
    return traceparent ? { traceparent } : undefined
  }

  private async prompted(sessionId: string, headers?: Record<string, string>): Promise<boolean> {
    const id = inputId(sessionId, 'prompt')
    const [messages, inbox] = await Promise.all([
      this.client.messages(sessionId, headers),
      this.client.inbox(sessionId, headers),
    ])
    return promptIndex(messages, id) >= 0 || inbox.some((m) => m.id === id)
  }

  /**
   * The step key's first session generation that is new, or exists unprompted in this location (a crash between
   * create and journal). A prompted one belongs to an earlier, failed attempt: the retry gets the next generation.
   */
  private async sessionFor(key: string, directory: string, headers?: Record<string, string>): Promise<string> {
    for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
      const id = sessionIdFor(key, generation)
      const existing = await this.client.getSession(id, headers)
      if (!existing) return id
      if (existing.location.directory === directory && !(await this.prompted(id, headers))) return id
    }
    throw new WorkflowError('error', `step ${key} used ${MAX_GENERATIONS} sessions; refusing another`)
  }

  /** One read of the session; null on a transient failure (logged), so the loop polls on without progress. */
  private async read(
    h: OpenCodeHandle,
    reader: SessionReader,
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<Snapshot | null> {
    try {
      const [messages, active, inbox] = await Promise.all([
        reader.read(),
        this.client.active(headers),
        this.client.inbox(h.sessionId, headers),
      ])
      return { messages, active: active.has(h.sessionId), pending: inbox.length > 0 }
    } catch (err) {
      if (signal.aborted) throw signal.reason
      if (err instanceof OpenCodeHttpError && err.status === 404) {
        throw new WorkflowError('error', `opencode session ${h.sessionId} is gone`, { cause: err })
      }
      if (!transient(err)) throw err
      reader.invalidate()
      return null
    }
  }

  /** One synthetic note per cut-off point (its id is keyed by the last message), appended, never a rewrite. */
  private async resume(h: OpenCodeHandle, lastId: string): Promise<void> {
    this.logger.warn('opencode session cut off, resuming', { sessionId: h.sessionId, after: lastId })
    try {
      await this.client.synthetic(
        h.sessionId,
        {
          id: inputId(h.sessionId, 'resume', lastId),
          text: RESUME_TEXT,
          description: 'agw re-attach',
          metadata: { agw: { kind: 'resume' } },
        },
        this.headers(h.runId, h.stepId),
      )
    } catch (err) {
      if (!transient(err)) throw err
      this.logger.warn('opencode resume failed; retried next poll', {
        sessionId: h.sessionId,
        error: (err as Error).name,
      })
    }
  }

  private async reportTools(
    parts: ToolPart[],
    seen: Map<string, 'pre' | 'post'>,
    options: AgentWaitOptions,
  ): Promise<void> {
    for (const part of parts) {
      const status = part.state?.status
      const event = {
        callId: part.id,
        tool: part.name,
        ...(part.state?.input ? { input: part.state.input as Json } : {}),
      }
      if (!seen.has(part.id)) {
        seen.set(part.id, 'pre')
        await options.onTool({ phase: 'pre', ...event })
      }
      if (seen.get(part.id) !== 'pre' || (status !== 'completed' && status !== 'error')) continue
      seen.set(part.id, 'post')
      const text = (part.state?.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .slice(0, TOOL_TEXT_LIMIT)
      const error = part.state?.error
      await options.onTool({
        phase: 'post',
        ...event,
        ...(status === 'completed' ? { output: text } : {}),
        ...(status === 'error'
          ? { error: typeof error === 'string' ? error : (error?.message ?? (text || 'tool failed')) }
          : {}),
      })
    }
  }

  /** A running shell tool changes nothing in the messages; its printed bytes are its progress. */
  private async shellGrew(h: OpenCodeHandle, messages: Message[], shells: Map<string, number>): Promise<boolean> {
    let grew = false
    for (const m of messages) {
      if (m.type !== 'assistant') continue
      for (const part of m.content ?? []) {
        const shellId = part.state?.metadata?.shellID
        if (part.type !== 'tool' || part.state?.status !== 'running' || typeof shellId !== 'string') continue
        let size: number
        try {
          size = await this.client.shellOutputSize(shellId, h.directory)
        } catch (err) {
          this.logger.warn('opencode shell output read failed', { sessionId: h.sessionId, error: (err as Error).name })
          continue
        }
        const before = shells.get(shellId)
        if (before !== undefined && size > before) grew = true
        shells.set(shellId, size)
      }
    }
    return grew
  }

  private async finish(
    h: OpenCodeHandle,
    reader: SessionReader,
    promptId: string,
    state: { outcome: Outcome; error?: string },
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (state.outcome === 'interrupted' && signal.aborted) throw signal.reason
    if (state.outcome !== 'succeeded') {
      throw new WorkflowError(
        'error',
        `opencode session ${h.sessionId} ${state.outcome}: ${state.error ?? 'no detail'}`,
      )
    }
    reader.invalidate()
    const messages = await reader.read()
    const text = finalText(messages, promptId)
    return { output: h.output === 'json' ? parseStructured(text) : text, usage: this.usage(h, messages) }
  }

  /**
   * Tokens from the messages (`usageFromOpenCodeMessages`), cost per message: OpenCode's when it is positive (it
   * prices with the config's cost rows, i.e. the route's rate); a message it reports at 0 with tokens is priced with
   * the route's rate (`costFromUsage`), else the step is unpriced. A call above the long-prompt tier is unpriced
   * either way: never free, never under-priced.
   */
  private usage(h: OpenCodeHandle, messages: Message[]): Usage {
    const usage = usageFromOpenCodeMessages(messages, { model: h.model })
    const rate = this.routeRate(h)
    let cost = 0
    let byRate = false
    for (const m of messages) {
      if (m.type !== 'assistant' || !m.tokens) continue
      const t = m.tokens
      const cacheRead = t.cache?.read ?? 0
      const cacheWrite = t.cache?.write ?? 0
      const total = (t.input ?? 0) + cacheRead + cacheWrite + (t.output ?? 0) + (t.reasoning ?? 0)
      if (total === 0) continue
      if ((t.input ?? 0) + cacheRead + cacheWrite > LONG_PROMPT_TOKENS) return unpriced(usage)
      if (typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost > 0) {
        cost += m.cost
        continue
      }
      const priced = costFromUsage(
        'opencode',
        {
          input_tokens: t.input ?? 0,
          output_tokens: (t.output ?? 0) + (t.reasoning ?? 0),
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
        },
        rate ?? undefined,
      )
      if (priced.usd === null) return unpriced(usage)
      cost += priced.usd
      byRate = true
    }
    return { ...usage, cost, costSource: byRate ? 'rate' : 'provider' }
  }

  private routeRate(h: OpenCodeHandle): Rate | null {
    try {
      return rateFor(modelRef(h.route, this.env).route)
    } catch {
      return null
    }
  }
}

const unpriced = (usage: Usage): Usage => ({ ...usage, cost: null, costSource: 'unknown' })
