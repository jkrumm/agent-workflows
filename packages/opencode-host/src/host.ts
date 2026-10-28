import { usageFromOpenCodeMessages } from '@agent-workflows/middleware'
import type { RouteId } from '@agent-workflows/routes'
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
} from './client.ts'
import { modelRef, rateFor } from './config.ts'
import { type AgentDefinition, compileLocation, WarmCache, type WarmCacheOptions } from './locations.ts'
import {
  activityFingerprint,
  finalText,
  inputId,
  parseStructured,
  promptIndex,
  sessionState,
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
  /** A session must look cut off this long before the host resumes it (covers admission races). Default 3 s. */
  cutoffGraceMs?: number
  locations?: WarmCacheOptions & { tickMs?: number }
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
  /** The route's rate prices cache reads / writes; else such tokens make the step unpriced. */
  priced: { any: boolean; cacheRead: boolean; cacheWrite: boolean }
}

/** Above this many prompt tokens in one call the vendor bills a higher tier (routes `costFromUsage`). */
const PROMPT_TIER_TOKENS = 100_000
const TOOL_TEXT_LIMIT = 10_000

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

/**
 * The runtime's `AgentHost` on one OpenCode server (concept §3, §8). One session per agent step, in the agent's
 * compiled location. Every input the host writes carries a deterministic message id and `metadata.agw.kind`, so
 * `prompt` is exact and a re-sent input is deduped by the server too. `wait` polls the session until it is idle and
 * re-attaches across server restarts: a turn the server lost mid-way is resumed with one appended synthetic note.
 */
export class OpenCodeHost implements AgentHost {
  private readonly client: OpenCodeClient
  private readonly agents: Map<string, AgentDefinition>
  private readonly cache: WarmCache
  private readonly pollMs: number
  private readonly cutoffGraceMs: number
  private readonly env: Env
  private readonly logger: Logger
  /** Tool calls already reported per session, so a second `wait` in this process does not repeat them. */
  private readonly toolsSeen = new Map<string, Map<string, 'pre' | 'post'>>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly options: OpenCodeHostOptions) {
    this.client = createClient(() => options.server.endpoint(), { requestTimeoutMs: options.requestTimeoutMs })
    this.agents = new Map(options.agents.map((a) => [a.name, a]))
    this.pollMs = options.pollIntervalMs ?? 1_000
    this.cutoffGraceMs = options.cutoffGraceMs ?? 3_000
    this.env = options.env ?? process.env
    this.logger = options.logger ?? consoleLogger
    this.cache = new WarmCache(
      { warm: (dir) => this.client.location(dir), evict: (dir) => this.client.evictLocation(dir) },
      options.locations,
    )
    options.server.onRestart?.(() => this.cache.reset())
    this.timer = setInterval(() => {
      this.cache.tick().catch((err: unknown) => {
        this.logger.warn('opencode location eviction failed', { error: (err as Error).message })
      })
    }, options.locations?.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  /** Locations the server currently holds warm for this host. */
  warmLocations(): string[] {
    return this.cache.warm()
  }

  /** Evicts idle locations now (the timer does it every `locations.tickMs`). */
  evictIdle(): Promise<void> {
    return this.cache.tick()
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
    const rate = rateFor(route, this.env)
    const location = compileLocation(def, { stateDir: this.options.stateDir })
    await this.options.server.ready()
    const release = await this.cache.use(location.directory, { changed: location.changed })
    release()
    const session = await this.client.createSession(
      {
        // A title set at create skips OpenCode's background title call (billed to the session otherwise).
        title: `agw ${spec.runId}:${spec.stepId}`,
        location: { directory: location.directory },
        model,
        metadata: { agw: { key: spec.key, agent: def.name, route: routeId, locationHash: location.hash } },
      },
      this.headers(spec.runId, spec.stepId),
    )
    const handle: OpenCodeHandle = {
      v: 1,
      sessionId: session.id,
      directory: location.directory,
      agent: def.name,
      route: routeId,
      model: route.model,
      output: options.output === 'json' ? 'json' : 'text',
      runId: spec.runId,
      stepId: spec.stepId,
      priced: {
        any: rate !== null,
        cacheRead: rate?.cacheReadPerM !== undefined,
        cacheWrite: rate?.cacheWritePerM !== undefined,
      },
    }
    return handle
  }

  /** Reads the session first and sends only when the prompt is not there (messages or inbox); the id dedupes too. */
  async prompt(handle: Json, prompt: string): Promise<void> {
    const h = asHandle(handle)
    const id = inputId(h.sessionId, 'prompt')
    const headers = this.headers(h.runId, h.stepId)
    const [messages, inbox] = await Promise.all([
      this.client.messages(h.sessionId, headers),
      this.client.inbox(h.sessionId, headers),
    ])
    if (promptIndex(messages, id) >= 0 || inbox.some((m) => m.id === id)) return
    await this.client.prompt(h.sessionId, { id, text: prompt, metadata: { agw: { kind: 'prompt' } } }, headers)
  }

  async wait(handle: Json, options: AgentWaitOptions): Promise<AgentResult> {
    const h = asHandle(handle)
    const { signal } = options
    const promptId = inputId(h.sessionId, 'prompt')
    const headers = this.headers(h.runId, h.stepId)
    const shells = new Map<string, number>()
    let release: (() => void) | null = null
    let fingerprint: string | null = null
    let cutoffSince: number | null = null
    try {
      for (;;) {
        signal.throwIfAborted()
        await this.options.server.ready(signal)
        let messages: Message[]
        let view: { active: boolean; pending: boolean }
        try {
          release ??= await this.cache.use(h.directory)
          const [msgs, active, inbox] = await Promise.all([
            this.client.messages(h.sessionId, headers),
            this.client.active(headers),
            this.client.inbox(h.sessionId, headers),
          ])
          messages = msgs
          view = { active: active.has(h.sessionId), pending: inbox.length > 0 }
        } catch (err) {
          if (signal.aborted) throw signal.reason
          if (err instanceof OpenCodeHttpError && err.status === 404) {
            throw new WorkflowError('error', `opencode session ${h.sessionId} is gone`, { cause: err })
          }
          if (!transient(err)) throw err
          await abortableSleep(this.pollMs, signal)
          continue
        }

        const next = activityFingerprint(messages)
        if (next !== fingerprint) {
          if (fingerprint !== null) options.onProgress()
          fingerprint = next
        }
        await this.reportTools(h, toolParts(messages, promptId), options)
        if (await this.shellGrew(h, messages, shells)) options.onProgress()

        const state = sessionState(messages, { promptId, ...view })
        if (state.kind === 'unprompted') {
          throw new WorkflowError('error', `opencode session ${h.sessionId} holds no prompt; wait before prompt`)
        }
        if (state.kind === 'done') return this.finish(h, messages, promptId, state, signal)
        if (state.kind === 'cutoff') {
          cutoffSince ??= Date.now()
          if (Date.now() - cutoffSince >= this.cutoffGraceMs) {
            await this.resume(h, state.lastId).catch((err: unknown) => {
              if (!transient(err)) throw err
            })
            cutoffSince = null
          }
        } else {
          cutoffSince = null
        }
        await abortableSleep(this.pollMs, signal)
      }
    } finally {
      release?.()
    }
  }

  /** Appends a user message (`delivery: steer`); history is never rewritten. A re-delivered steer is deduped. */
  async steer(handle: Json, text: string): Promise<void> {
    const h = asHandle(handle)
    const id = inputId(h.sessionId, 'steer', text)
    await this.client.prompt(
      h.sessionId,
      { id, text, delivery: 'steer', metadata: { agw: { kind: 'steer' } } },
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

  /** One synthetic note per cut-off point (its id is keyed by the last message), appended, never a rewrite. */
  private async resume(h: OpenCodeHandle, lastId: string): Promise<void> {
    this.logger.warn('opencode session cut off, resuming', { sessionId: h.sessionId, after: lastId })
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
  }

  private async reportTools(h: OpenCodeHandle, parts: ToolPart[], options: AgentWaitOptions): Promise<void> {
    let seen = this.toolsSeen.get(h.sessionId)
    if (!seen) {
      seen = new Map()
      this.toolsSeen.set(h.sessionId, seen)
    }
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
      if (seen.get(part.id) === 'pre' && (status === 'completed' || status === 'error')) {
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
  }

  /** A running shell tool changes nothing in the messages; its printed bytes are its progress. */
  private async shellGrew(h: OpenCodeHandle, messages: Message[], shells: Map<string, number>): Promise<boolean> {
    let grew = false
    for (const m of messages) {
      if (m.type !== 'assistant') continue
      for (const part of m.content ?? []) {
        const shellId = part.state?.metadata?.shellID
        if (part.type !== 'tool' || part.state?.status !== 'running' || typeof shellId !== 'string') continue
        const size = await this.client.shellOutputSize(shellId, h.directory).catch(() => null)
        if (size === null) continue
        const before = shells.get(shellId)
        if (before !== undefined && size > before) grew = true
        shells.set(shellId, size)
      }
    }
    return grew
  }

  private finish(
    h: OpenCodeHandle,
    messages: Message[],
    promptId: string,
    state: { outcome: 'succeeded' | 'failed' | 'interrupted'; error?: string },
    signal: AbortSignal,
  ): AgentResult {
    if (state.outcome === 'interrupted' && signal.aborted) throw signal.reason
    if (state.outcome !== 'succeeded') {
      throw new WorkflowError(
        'error',
        `opencode session ${h.sessionId} ${state.outcome}: ${state.error ?? 'no detail'}`,
      )
    }
    this.toolsSeen.delete(h.sessionId)
    const text = finalText(messages, promptId)
    return { output: h.output === 'json' ? parseStructured(text) : text, usage: this.usage(h, messages) }
  }

  /**
   * Tokens and cost from the messages (`usageFromOpenCodeMessages`). OpenCode prices with the config's cost rows,
   * which come from the route table; where the table has no matching rate, OpenCode's number is a fake 0, so the
   * step is reported unpriced instead, never under-priced. Same for one call above the 100K prompt tier.
   */
  private usage(h: OpenCodeHandle, messages: Message[]): Usage {
    const usage = usageFromOpenCodeMessages(messages, { model: h.model })
    const assistants = messages.filter((m) => m.type === 'assistant' && m.tokens)
    const overTier = assistants.some((m) => {
      const t = m.tokens ?? {}
      return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) > PROMPT_TIER_TOKENS
    })
    const unpricedCache =
      (!h.priced.cacheRead && usage.tokens.cacheRead > 0) ||
      (!h.priced.cacheWrite && (usage.tokens.cacheWrite ?? 0) > 0)
    if (!h.priced.any || overTier || unpricedCache) return { ...usage, cost: null, costSource: 'unknown' }
    return usage
  }
}
