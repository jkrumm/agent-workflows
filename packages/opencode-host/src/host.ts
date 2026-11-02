import { type StepSessions, usageFromOpenCodeMessages } from '@agent-workflows/middleware'
import { costFromUsage, isBalanceFailure, type Rate, type RouteId } from '@agent-workflows/routes'
import {
  type AgentFollowUpSpec,
  type AgentHost,
  type AgentOpenSpec,
  type AgentResult,
  type AgentWaitOptions,
  type Attribution,
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
import { fallbackModelRef, modelRef, rateFor } from './config.ts'
import {
  type AgentDefinition,
  basePolicy,
  compileLocation,
  pruneLocations,
  sweepStaleTemps,
  touchLocation,
  WarmCache,
  type WarmCacheOptions,
} from './locations.ts'
import {
  activityFingerprint,
  finalText,
  inputId,
  nudgeId,
  nudgeThreshold,
  type Outcome,
  Persisting,
  type SessionState,
  promptIndex,
  repeatCounts,
  SessionReader,
  type SessionCounters,
  sessionCounters,
  sessionIdFor,
  sessionState,
  steerId,
  submittedResult,
  type ToolPart,
  toolParts,
} from './session.ts'
import { RESULT_TOOL, resultTool, resultValue, withResultTool } from './result.ts'

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
  requestTimeoutMs?: number
  /** A pin taken at `open` and never claimed by a `wait` lapses after this long. Default 30 min. */
  pinTtlMs?: number
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
  /** The step's `allowDirectories`, kept so a provider-balance fallback session gets the same permissions. */
  allow?: string[]
  /** Set on the session the host opened on the route's fallback; it never falls back again. */
  fallback?: true
  /** A follow-up turn (`followUp`): its input is keyed by this, and `wait` reads only what came after it. */
  turn?: string
  /** The step's attribution, kept so a provider-balance fallback session carries it too. */
  attribution?: StepAttribution
  /**
   * The run's arm patch of this step's route (`arm.routes[route]`), kept so the fallback and the pricing resolve the
   * route the session was opened on. Absent: the table's route.
   */
  patch?: { [key: string]: Json }
  /**
   * Set on every JSON step this build opened (README §Structured output): the digest of its result tool's schema, and
   * `wrapped` when that schema holds the step's under `result` (`wait` unwraps it). A JSON handle without it was opened
   * before the result tool existed and has none in its session.
   */
  result?: { digest: string; wrapped?: true }
}

/**
 * The `Attribution` fields `metadata.agw` holds. Not `traceparent`: OpenCode's HTTP client writes its own on the wire
 * (README §Attribution), and one per step span would only cost a `PATCH`.
 */
const SESSION_ATTRIBUTION = [
  'runId',
  'rootId',
  'workflow',
  'step',
  'purpose',
  'project',
  'workspace',
] as const satisfies readonly (keyof Attribution)[]

/** A handle journaled before a deploy holds no attribution, only its run and step. */
type StepAttribution = Pick<Attribution, 'runId' | 'step'> &
  Partial<Pick<Attribution, (typeof SESSION_ATTRIBUTION)[number]>>

/** `agw` with its attribution fields replaced by `attribution`, the host's own fields kept. */
function withAttribution(agw: Record<string, unknown>, attribution: StepAttribution): Record<string, unknown> {
  const own = Object.entries(agw).filter(([field]) => !(SESSION_ATTRIBUTION as readonly string[]).includes(field))
  return { ...Object.fromEntries(own), ...attribution }
}

function sessionAttribution(attribution: Attribution): StepAttribution {
  const fields = { ...attribution }
  delete fields.traceparent
  return fields
}

type Snapshot = { messages: Message[]; active: boolean; pending: boolean }

const TOOL_TEXT_LIMIT = 10_000
/** Session generations tried for one step key before giving up (one per failed attempt). */
const MAX_GENERATIONS = 100
/** A pin taken at `open` and never claimed by a `wait` (the step aborted in between) lapses after this long. */
const PIN_TTL_MS = 30 * 60_000

type Pin = { release: () => void; lapse: ReturnType<typeof setTimeout> }

const RESUME_TEXT =
  'The previous turn was cut off when the agent server restarted before it finished. Continue the task from ' +
  'where it stopped and complete it. Do not repeat tool calls whose results are already above.'

/** A nudge post that keeps failing transiently is tried this many times, then given up. */
const NUDGE_ATTEMPTS = 3

/** The repeat-tool note (concept §7): said once per threshold, never an abort and never a cap. */
const nudgeText = (tool: string, count: number) =>
  `You have called the "${tool}" tool with identical input ${count} times in this session. Repeating the same call ` +
  'will not give a different result. Change your approach (a different tool, a different input, a different line ' +
  'of attack), or answer with what you already have.'

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
}

function asHandle(handle: Json): OpenCodeHandle {
  const h = handle as Partial<OpenCodeHandle> | null
  const strings = ['sessionId', 'directory', 'agent', 'route', 'model', 'runId', 'stepId'] as const
  if (
    !h ||
    typeof h !== 'object' ||
    h.v !== 1 ||
    strings.some((k) => typeof h[k] !== 'string') ||
    (h.output !== 'json' && h.output !== 'text') ||
    (h.allow !== undefined && (!Array.isArray(h.allow) || h.allow.some((d) => typeof d !== 'string'))) ||
    (h.fallback !== undefined && h.fallback !== true) ||
    (h.turn !== undefined && typeof h.turn !== 'string') ||
    (h.result !== undefined && !validResultMarker(h.result)) ||
    (h.attribution !== undefined && (typeof h.attribution !== 'object' || h.attribution === null)) ||
    (h.patch !== undefined && (typeof h.patch !== 'object' || h.patch === null || Array.isArray(h.patch)))
  ) {
    throw new WorkflowError('error', 'not an OpenCode host handle')
  }
  return h as OpenCodeHandle
}

/** The handle's route patch as `resolveRoute` takes it. */
function patchOf(h: OpenCodeHandle): { [routeId: string]: object } | undefined {
  return h.patch ? { [h.route]: h.patch } : undefined
}

function validResultMarker(marker: unknown): boolean {
  if (marker === null || typeof marker !== 'object') return false
  const { digest, wrapped } = marker as { digest?: unknown; wrapped?: unknown }
  return typeof digest === 'string' && (wrapped === undefined || wrapped === true)
}

/** A JSON handle from before the result tool: its session has no `submit_result`, so no turn of it can answer. */
function assertResultMarker(h: OpenCodeHandle): void {
  if (h.output !== 'json' || h.result !== undefined) return
  throw new WorkflowError(
    'error',
    `opencode session ${h.sessionId} (agent "${h.agent}"): a JSON step opened before the ${RESULT_TOOL} tool was ` +
      'deployed; its session has no result tool and cannot answer. A new attempt opens a session that has it.',
  )
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
 * Deny by default, as agent-gateway's `OPENCODE_READONLY_PERMISSIONS`: the catch-all deny first, the read-only allows
 * next, the shell only when the agent opts in (`permissions.shell`), then the agent's own `rules` (an opt-in such as
 * `webfetch`, `websearch`, `subagent` or `edit` is an `allow` there and wins), the step's `allowDirectories` last: last
 * match wins. The server config denies `external_directory` everywhere; a directory a step names is opened for reads
 * again by an `allow` on `<dir>/*` (measured on 2.0.32: `<dir>/*` and `<dir>/**` match the path as given, a deeper file
 * included; `<dir>` alone and the symlink-resolved path do not). A JSON step (`resultTool`) is allowed its result
 * tool (README §Structured output) without the agent naming it.
 */
export function sessionPermissions(
  def: AgentDefinition,
  options: { allowDirectories?: readonly string[]; resultTool?: boolean } = {},
): PermissionRule[] {
  const { allowDirectories = [], resultTool = false } = options
  return [
    ...basePolicy(),
    ...(def.permissions?.shell ? [{ action: 'shell', resource: '*', effect: 'allow' } satisfies PermissionRule] : []),
    ...(resultTool ? [{ action: RESULT_TOOL, resource: '*', effect: 'allow' } satisfies PermissionRule] : []),
    ...(def.permissions?.rules ?? []),
    ...allowDirectories.map((dir): PermissionRule => ({
      action: 'external_directory',
      resource: `${dir}/*`,
      effect: 'allow',
    })),
  ]
}

const GLOB_CHARS = /[*?[\]{}]/

const STEP_OPTIONS = ['route', 'output', 'allowDirectories'] as const

/**
 * The step's `spec.options`: an object with only the keys the host knows. An unknown key (a typo, an option removed
 * with its code such as `repoShell`) fails the step before a session exists, so a rule the caller counts on can never
 * be silently absent.
 */
function stepOptions(agent: string, raw: unknown): { route?: RouteId; output?: string; allowDirectories?: unknown } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError('error', `agent "${agent}": options must be an object`)
  }
  const unknown = Object.keys(raw).filter((key) => !(STEP_OPTIONS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new WorkflowError(
      'error',
      `agent "${agent}": unknown option ${unknown.map((k) => JSON.stringify(k)).join(', ')} (known: ${STEP_OPTIONS.join(', ')})`,
    )
  }
  return raw
}

/**
 * `spec.options.allowDirectories`: absolute directories without glob characters, never the filesystem root. A
 * wildcard would widen the grant past the directory the caller named; a relative path means nothing to a session
 * that runs in its own location.
 */
function allowedDirectories(agent: string, raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((d) => typeof d !== 'string')) {
    throw new WorkflowError('error', `agent "${agent}": allowDirectories must be an array of strings`)
  }
  return raw.map((dir: string) => {
    const trimmed = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
    if (!trimmed.startsWith('/') || trimmed === '/' || GLOB_CHARS.test(trimmed) || trimmed.split('/').includes('..')) {
      throw new WorkflowError(
        'error',
        `agent "${agent}": allowDirectories entry "${dir}" must be an absolute directory without wildcards or ".." (not "/")`,
      )
    }
    return trimmed
  })
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
  private readonly logger: Logger
  private readonly timer: ReturnType<typeof setInterval>
  /** Hash directory per agent compiled by this process: always kept by pruning. */
  private readonly current = new Map<string, string>()
  /** The location use `open` took for a session, handed to its `wait`: no eviction gap between the two. */
  private readonly pins = new Map<string, Pin>()

  constructor(private readonly options: OpenCodeHostOptions) {
    this.client = createClient(() => options.server.endpoint(), { requestTimeoutMs: options.requestTimeoutMs })
    this.agents = new Map(options.agents.map((a) => [a.name, a]))
    this.pollMs = options.pollIntervalMs ?? 1_000
    this.cutoffGraceMs = options.cutoffGraceMs ?? 3_000
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

  /** Evicts idle locations, prunes unused hash directories and sweeps stale temp writes now (the timer does it every `locations.tickMs`). */
  async maintain(): Promise<string[]> {
    await this.cache.tick()
    const swept = sweepStaleTemps({ stateDir: this.options.stateDir })
    const keep = new Set([...this.cache.known(), ...this.current.values()])
    for (const id of await this.client.active()) {
      let session: Awaited<ReturnType<OpenCodeClient['getSession']>>
      try {
        session = await this.client.getSession(id)
      } catch (err) {
        // Any failure, Error or not: a running session's directory is unknown, and pruning now could remove it
        // under the turn. Next tick.
        this.logger.warn('opencode session lookup failed; pruning skipped this tick', {
          sessionId: id,
          error: err instanceof Error ? err.name : typeof err,
        })
        return swept
      }
      if (session === null) continue // ended and gone between the two calls
      keep.add(session.location.directory)
    }
    const pruned = pruneLocations({
      stateDir: this.options.stateDir,
      keep,
      retentionMs: this.options.locations?.retentionMs ?? 24 * 3_600_000,
    })
    return [...pruned, ...swept]
  }

  close(): void {
    clearInterval(this.timer)
    for (const pin of [...this.pins.values()]) pin.release()
  }

  async open(spec: AgentOpenSpec): Promise<Json> {
    const def = this.agents.get(spec.agent)
    if (!def)
      throw new WorkflowError('error', `unknown agent "${spec.agent}" (known: ${[...this.agents.keys()].join(', ')})`)
    const options = stepOptions(def.name, spec.options)
    const allowDirectories = allowedDirectories(def.name, options.allowDirectories)
    const routeId = options.route ?? def.route
    if (!routeId) throw new WorkflowError('error', `agent "${spec.agent}" has no route and the step names none`)
    // The run's arm moves the route's model or effort (admission checked that the server serves it); without one, the table.
    const { route, model } = modelRef(routeId, spec.arm?.routes)
    const patch = spec.arm?.routes?.[routeId]
    const attribution = sessionAttribution(spec.attribution)
    // A JSON step's location holds its result tool; a schema the tool cannot take is refused before anything exists.
    const json = options.output === 'json'
    const tool = json ? resultTool(def.name, spec) : null
    const location = compileLocation(tool ? withResultTool(def, tool) : def, { stateDir: this.options.stateDir })
    this.current.set(def.name, location.directory)
    touchLocation(location.directory)
    await this.options.server.ready()
    const warmed = await this.cache.use(location.directory, { changed: location.changed })
    const headers = this.headers(spec.runId, spec.stepId)
    let sessionId: string
    let directory: string
    let existed: boolean
    try {
      ;({ id: sessionId, directory, existed } = await this.sessionFor(spec.key, location.directory, headers))
      if (directory !== location.directory) {
        // Re-attaching in an older hash directory: renew its marker (pruning) and pin it, not the new one.
        touchLocation(directory)
        this.pin(sessionId, await this.cache.use(directory))
        warmed()
      } else {
        this.pin(sessionId, warmed)
      }
    } catch (err) {
      warmed()
      throw err
    }
    // A second create with the same id returns the first session (measured), so a crash right here is harmless.
    const permissions = sessionPermissions(def, { allowDirectories, resultTool: json })
    try {
      await this.client.createSession(
        {
          id: sessionId,
          // A title set at create skips OpenCode's background title call (billed to the session otherwise).
          title: `agw ${spec.runId}:${spec.stepId}`,
          location: { directory },
          model,
          permissions,
          metadata: {
            agw: { key: spec.key, agent: def.name, route: routeId, locationHash: location.hash, ...attribution },
          },
        },
        headers,
      )
      // The create above returned the session that was already there: it keeps the policy and the metadata it was made
      // with (a session from before a deploy). Set the current ones; the next turn reads them.
      if (existed) await this.applySession(sessionId, permissions, attribution, headers)
    } catch (err) {
      // Fail closed, and give back the warm-location pin and its cache use the session took above.
      this.pins.get(sessionId)?.release()
      throw err
    }
    const handle: OpenCodeHandle = {
      v: 1,
      sessionId,
      directory,
      agent: def.name,
      route: routeId,
      model: route.model,
      output: json ? 'json' : 'text',
      runId: spec.runId,
      stepId: spec.stepId,
      attribution,
      ...(patch ? { patch } : {}),
      ...(allowDirectories.length > 0 ? { allow: allowDirectories } : {}),
      ...(tool ? { result: { digest: tool.digest, ...(tool.wrapped ? { wrapped: true as const } : {}) } } : {}),
    }
    return handle
  }

  /** Reads the session first and sends only when the prompt is not there (messages or inbox); the id dedupes too. */
  async prompt(handle: Json, prompt: string): Promise<void> {
    const h = asHandle(handle)
    const headers = this.headers(h.runId, h.stepId)
    if (h.turn !== undefined) return this.promptTurn(h, h.turn, prompt, headers)
    if (await this.prompted(h.sessionId, headers)) return
    const id = inputId(h.sessionId, 'prompt')
    await this.client.prompt(h.sessionId, { id, text: prompt, metadata: { agw: { kind: 'prompt' } } }, headers)
  }

  /**
   * A follow-up turn in the session of an earlier step (`ctx.continue`): same session, same location, its history and
   * prompt cache. The new handle names the continuing step and the turn (step key and attempt, so a retry sends a new
   * turn); a step that moved to its fallback session continues there. Sends nothing: `prompt` does.
   */
  async followUp(handle: Json, spec: AgentFollowUpSpec): Promise<Json> {
    const h = asHandle(handle)
    const headers = this.headers(spec.runId, spec.stepId)
    let base: OpenCodeHandle = h
    if (!h.fallback && (await this.client.getSession(fallbackSessionId(h.sessionId), headers))) {
      const fallback = this.fallbackOf(h)
      if (!fallback)
        throw new WorkflowError('error', `opencode session ${h.sessionId}: fallback session without a route`)
      base = { ...h, sessionId: fallbackSessionId(h.sessionId), model: fallback.route.model, fallback: true }
    }
    if (!(await this.client.getSession(base.sessionId, headers))) {
      throw new WorkflowError('error', `opencode session ${base.sessionId} is gone; nothing to continue`)
    }
    // The session may predate the release that serves this turn, or be the fallback session: between turns is where
    // the policy is measured to take effect, so set the current one now (a no-op when it is already there). The turn
    // belongs to the continuing step, so its model calls carry that step's attribution, not the first step's.
    const def = this.agents.get(base.agent)
    if (!def) throw new WorkflowError('error', `unknown agent "${base.agent}"; cannot apply its permissions`)
    this.assertContinuable(base, spec)
    const attribution = sessionAttribution(spec.attribution)
    await this.applySession(
      base.sessionId,
      sessionPermissions(def, { allowDirectories: base.allow ?? [], resultTool: base.output === 'json' }),
      attribution,
      headers,
    )
    const next: OpenCodeHandle = {
      ...base,
      runId: spec.runId,
      stepId: spec.stepId,
      attribution,
      turn: `${spec.key}#${spec.attempt}`,
    }
    return next
  }

  /**
   * A follow-up turn answers the way its session was opened: a JSON session through its result tool, whose schema is
   * the opened step's. The continuing step's output must therefore convert to the same tool schema; a different one
   * (text, or another shape) is refused before anything is sent. A text session answers in text whatever the step's
   * output, as before.
   */
  private assertContinuable(base: OpenCodeHandle, spec: AgentFollowUpSpec): void {
    if (base.output !== 'json') return
    assertResultMarker(base)
    let digest: string | null = null
    try {
      digest = resultTool(base.agent, spec).digest
    } catch {
      // no schema, or one the tool cannot take: certainly not the session's
    }
    if (digest === base.result?.digest) return
    throw new WorkflowError(
      'error',
      `continue step "${spec.stepId}": the session of agent "${base.agent}" answers through ${RESULT_TOOL} with the ` +
        "schema of the step that opened it; this step's output is a different one (text, or another shape)",
    )
  }

  /**
   * Makes the session's stored rules and attribution the given ones: one read, and a `PATCH` of what differs only (a
   * session created with the current ones, a re-attach within one release, costs no write). `PATCH` replaces `metadata`
   * whole, so the rest of it is sent back; the attribution fields are replaced, so one the new step lacks does not stay.
   * The rules are measured only between turns; a patch onto a session mid-turn is
   * unmeasured, which is why equal rules are never rewritten.
   */
  private async applySession(
    sessionId: string,
    permissions: PermissionRule[],
    attribution: StepAttribution,
    headers: Record<string, string> | undefined,
  ): Promise<void> {
    const stored = await this.client.getSession(sessionId, headers)
    const samePolicy =
      stored?.permissions !== undefined && JSON.stringify(stored.permissions) === JSON.stringify(permissions)
    const agw = (stored?.metadata?.agw ?? {}) as Record<string, unknown>
    const sameAttribution = SESSION_ATTRIBUTION.every((field) => agw[field] === attribution[field])
    if (samePolicy && sameAttribution) return
    await this.client.updateSession(
      sessionId,
      {
        ...(samePolicy ? {} : { permissions }),
        ...(sameAttribution ? {} : { metadata: { ...stored?.metadata, agw: withAttribution(agw, attribution) } }),
      },
      headers,
    )
  }

  /** A follow-up turn's input, sent once: the session (messages or inbox) is read first, and the id dedupes too. */
  private async promptTurn(
    h: OpenCodeHandle,
    turn: string,
    text: string,
    headers: Record<string, string> | undefined,
  ): Promise<void> {
    const id = turnInputId(h.sessionId, turn)
    const [messages, inbox] = await Promise.all([
      this.client.messages(h.sessionId, headers),
      this.client.inbox(h.sessionId, headers),
    ])
    if (turnIndex(messages, id, turn) >= 0 || inbox.some((m) => m.id === id)) return
    await this.client.prompt(h.sessionId, { id, text, metadata: { agw: { kind: 'followup', turn } } }, headers)
  }

  async wait(handle: Json, options: AgentWaitOptions): Promise<AgentResult> {
    const h = asHandle(handle)
    assertResultMarker(h)
    if (h.turn !== undefined) return this.waitTurn(h, h.turn, options)
    const { signal } = options
    const promptId = inputId(h.sessionId, 'prompt')
    const headers = this.headers(h.runId, h.stepId)
    const reader = new SessionReader({
      all: () => this.client.messages(h.sessionId, headers),
      recent: (limit) => this.client.recentMessages(h.sessionId, limit, headers),
    })
    const tools = new Map<string, 'pre' | 'post'>()
    const shells = new Map<string, number>()
    /** Nudge ids posted by this wait; the session's own messages cover the ones an earlier wait posted. */
    const nudged = new Set<string>()
    const nudgeFailures = new Map<string, number>()
    const cutoff = new Persisting()
    const unprompted = new Persisting()
    // The pin `open` took (same process), else a fresh use; retried on every poll while there is none.
    let release: (() => void) | null = this.claimPin(h.sessionId)
    let fingerprint: string | null = null
    touchLocation(h.directory)
    try {
      for (;;) {
        signal.throwIfAborted()
        await this.options.server.ready(signal)
        release ??= await this.cache.use(h.directory).catch((err: unknown) => {
          if (!transient(err)) throw err
          this.logger.warn('opencode location use failed; retried next poll', {
            sessionId: h.sessionId,
            error: (err as Error).name,
          })
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
          if (state.kind === 'done' && this.fallsBack(h, snap.messages, promptId, state)) {
            return await this.waitOnFallback(h, snap.messages, promptId, options)
          }
          if (state.kind === 'done') return await this.finish(h, reader, promptId, state, signal)
          if (state.kind === 'running') await this.nudge(h, snap.messages, promptId, nudged, nudgeFailures)
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
   * `wait` for a follow-up turn: the same loop, reading only the messages after the turn's input. Done is an idle
   * after the last input of the turn; a cut-off turn is resumed like a first one. No provider-balance fallback: the
   * session already ran on its route, a refused follow-up fails the step.
   */
  private async waitTurn(h: OpenCodeHandle, turn: string, options: AgentWaitOptions): Promise<AgentResult> {
    const { signal } = options
    const id = turnInputId(h.sessionId, turn)
    const headers = this.headers(h.runId, h.stepId)
    const reader = new SessionReader({
      all: () => this.client.messages(h.sessionId, headers),
      recent: (limit) => this.client.recentMessages(h.sessionId, limit, headers),
    })
    const tools = new Map<string, 'pre' | 'post'>()
    const cutoff = new Persisting()
    const unprompted = new Persisting()
    let release: (() => void) | null = null
    let fingerprint: string | null = null
    touchLocation(h.directory)
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
          const from = turnIndex(snap.messages, id, turn)
          const after = from < 0 ? [] : snap.messages.slice(from + 1)
          const next = activityFingerprint(after)
          if (fingerprint !== null && next !== fingerprint) options.onProgress()
          fingerprint = next
          await this.reportTools(turnTools(after), tools, options)
          const state = turnState(snap, from)
          if (unprompted.check(state.kind === 'unprompted', this.cutoffGraceMs)) {
            throw new WorkflowError(
              'error',
              `opencode session ${h.sessionId} holds no turn ${turn}; wait before prompt`,
            )
          }
          if (state.kind === 'done') {
            if (state.outcome === 'interrupted' && signal.aborted) throw signal.reason
            if (state.outcome !== 'succeeded') {
              throw new WorkflowError(
                'error',
                `opencode session ${h.sessionId} turn ${state.outcome}: ${state.error ?? 'no detail'}`,
              )
            }
            reader.invalidate()
            const all = await reader.read()
            const answer = all.slice(turnIndex(all, id, turn) + 1)
            return { output: this.output(h, [TURN_ANCHOR, ...answer], TURN_ANCHOR.id), usage: this.usage(h, answer) }
          }
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
    const headers = this.headers(h.runId, h.stepId)
    // The journal holds the step's first handle: once the step moved to its fallback session, that one is steered.
    const fallback = fallbackSessionId(h.sessionId)
    const sessionId = !h.fallback && (await this.client.getSession(fallback, headers)) ? fallback : h.sessionId
    await this.client.prompt(
      sessionId,
      { id: steerId(sessionId, options.signalId), text, delivery: 'steer', metadata: { agw: { kind: 'steer' } } },
      headers,
    )
  }

  /** Interrupts the running turn. Idempotent: an idle session answers `interrupted: false`, a gone one 404. */
  async abort(handle: Json): Promise<void> {
    const h = asHandle(handle)
    // The step's fallback session too, when it has one: the journal holds only the first handle. Every session is
    // interrupted before an error is raised, so a failing primary interrupt never leaves the fallback running.
    const errors: unknown[] = []
    for (const sessionId of h.fallback ? [h.sessionId] : [h.sessionId, fallbackSessionId(h.sessionId)]) {
      try {
        await this.client.interrupt(sessionId, this.headers(h.runId, h.stepId))
      } catch (err) {
        if (!(err instanceof OpenCodeHttpError && err.status === 404)) errors.push(err)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `opencode abort failed on ${errors.length} sessions`)
  }

  /**
   * A turn that failed on provider balance before it did anything (no tool call, no output) moves to the route's
   * fallback: a turn that ran is never prompted a second time, and a fallback session never falls back again.
   */
  private fallsBack(
    h: OpenCodeHandle,
    messages: readonly Message[],
    promptId: string,
    state: { outcome: Outcome; error?: string },
  ): boolean {
    if (h.fallback || state.outcome !== 'failed' || !state.error) return false
    if (!isBalanceFailure({ text: state.error })) return false
    if (turnRan(messages, promptId)) {
      this.logger.warn('opencode turn failed on provider balance after it ran; no fallback', { sessionId: h.sessionId })
      return false
    }
    return this.fallbackOf(h) !== undefined
  }

  private fallbackOf(h: OpenCodeHandle) {
    try {
      return fallbackModelRef(h.route, patchOf(h))
    } catch {
      return undefined
    }
  }

  /**
   * Opens the step's fallback session (its id derived from the failed session's, so a re-attach after a crash finds it
   * again), sends it the same prompt (a no-op when it is already there) and waits on it as on any session.
   */
  private async waitOnFallback(
    h: OpenCodeHandle,
    messages: readonly Message[],
    promptId: string,
    options: AgentWaitOptions,
  ): Promise<AgentResult> {
    const def = this.agents.get(h.agent)
    const fallback = this.fallbackOf(h)
    const prompt = promptText(messages, promptId)
    if (!def || !fallback || prompt === null) {
      throw new WorkflowError(
        'error',
        `opencode session ${h.sessionId} failed on provider balance; no fallback session`,
      )
    }
    const sessionId = fallbackSessionId(h.sessionId)
    const headers = this.headers(h.runId, h.stepId)
    this.logger.warn('opencode turn failed on provider balance; falling back', {
      sessionId: h.sessionId,
      fallbackSessionId: sessionId,
      route: h.route,
      from: h.model,
      to: fallback.route.model,
    })
    const permissions = sessionPermissions(def, { allowDirectories: h.allow ?? [], resultTool: h.output === 'json' })
    const attribution: StepAttribution = h.attribution ?? { runId: h.runId, step: h.stepId }
    await this.client.createSession(
      {
        id: sessionId,
        title: `agw ${h.runId}:${h.stepId} (fallback)`,
        location: { directory: h.directory },
        model: fallback.model,
        permissions,
        metadata: { agw: { agent: def.name, route: h.route, fallbackOf: h.sessionId, ...attribution } },
      },
      headers,
    )
    // A fallback session that survived a redeploy keeps its old rules; a fresh one already has the current ones.
    await this.applySession(sessionId, permissions, attribution, headers)
    const next: OpenCodeHandle = { ...h, sessionId, model: fallback.route.model, fallback: true }
    await this.prompt(next, prompt)
    return await this.wait(next, options)
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
   * The session an attempt of this step key works in. Walking the generations: a new one is created; an existing
   * one that is unprompted in this location is reused (a crash between create and journal); a prompted one that the
   * server still runs (or holds input for) is re-attached, because the earlier attempt's wait failed while its turn
   * went on (a throwing onTool, a read error). Opening a sibling would run the same task twice on the same files;
   * re-attaching costs nothing and its `prompt` is a no-op. Only a prompted session whose turn ended belongs to a
   * finished attempt: the retry moves to the next generation.
   */
  private async sessionFor(
    key: string,
    directory: string,
    headers?: Record<string, string>,
  ): Promise<{ id: string; directory: string; existed: boolean }> {
    const active = await this.client.active(headers)
    for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
      const id = sessionIdFor(key, generation)
      const existing = await this.client.getSession(id, headers)
      if (!existing) return { id, directory, existed: false }
      if (active.has(id) || (await this.client.inbox(id, headers)).length > 0) {
        this.logger.warn('opencode session of an earlier attempt still runs; re-attaching', { sessionId: id })
        return { id, directory: existing.location.directory, existed: true }
      }
      // The attempt moved to its fallback session and that one still runs: this generation is not finished. Its handle
      // is the primary's (as journaled); `wait` lands on the fallback again and `prompt` sends nothing.
      const fallback = fallbackSessionId(id)
      if (
        active.has(fallback) ||
        ((await this.client.getSession(fallback, headers)) && (await this.client.inbox(fallback, headers)).length > 0)
      ) {
        this.logger.warn('opencode fallback session of an earlier attempt still runs; re-attaching', {
          sessionId: id,
          fallbackSessionId: fallback,
        })
        return { id, directory: existing.location.directory, existed: true }
      }
      if (existing.location.directory === directory && !(await this.prompted(id, headers)))
        return { id, directory, existed: true }
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
      this.logger.warn('opencode session read failed; retried next poll', {
        sessionId: h.sessionId,
        error: (err as Error).name,
      })
      reader.invalidate()
      return null
    }
  }

  private pin(sessionId: string, release: () => void): void {
    this.pins.get(sessionId)?.release()
    let done = false
    const pin: Pin = {
      release: () => {
        if (done) return
        done = true
        clearTimeout(pin.lapse)
        if (this.pins.get(sessionId) === pin) this.pins.delete(sessionId)
        release()
      },
      lapse: setTimeout(() => pin.release(), this.options.pinTtlMs ?? PIN_TTL_MS),
    }
    pin.lapse.unref?.()
    this.pins.set(sessionId, pin)
  }

  /** Takes over the pin `open` left for this session, cancelling its lapse: the caller alone releases it now. */
  private claimPin(sessionId: string): (() => void) | null {
    const pin = this.pins.get(sessionId)
    if (!pin) return null
    this.pins.delete(sessionId)
    clearTimeout(pin.lapse)
    return pin.release
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

  /**
   * Appends one synthetic note when a tool+input reaches its 3rd, 5th or 8th call in this session. Counts are
   * recomputed from the messages on every poll, the note's id is keyed by (tool+input, threshold), and a note already
   * in the session is never sent again, so a re-attach, a jump across two thresholds or a repeated poll sends
   * nothing extra. Never aborts the turn.
   */
  private async nudge(
    h: OpenCodeHandle,
    messages: readonly Message[],
    promptId: string,
    sent: Set<string>,
    failures: Map<string, number>,
  ) {
    const present = new Set(messages.map((m) => m.id))
    for (const [key, count] of repeatCounts(toolParts(messages, promptId))) {
      const at = nudgeThreshold(count)
      if (at === null) continue
      const id = nudgeId(h.sessionId, key, at)
      if (sent.has(id) || present.has(id)) continue
      const tool = key.slice(0, key.indexOf('\0'))
      try {
        await this.client.synthetic(
          h.sessionId,
          {
            id,
            text: nudgeText(tool, count),
            description: 'agw repeat-tool nudge',
            metadata: { agw: { kind: 'nudge' } },
          },
          this.headers(h.runId, h.stepId),
        )
        sent.add(id)
        this.logger.warn('opencode repeat-tool nudge', { sessionId: h.sessionId, tool, count })
      } catch (err) {
        // Advisory, so never fatal: a transient failure is retried on the next polls (a few times), anything else gives
        // this threshold up. A given-up nudge is visible afterwards as `nudgesMissed` in the session's counters.
        const retryable = transient(err)
        const failed = (failures.get(id) ?? 0) + 1
        failures.set(id, failed)
        const gaveUp = !retryable || failed >= NUDGE_ATTEMPTS
        if (gaveUp) sent.add(id)
        this.logger.warn('opencode nudge not sent; the turn goes on', {
          sessionId: h.sessionId,
          tool,
          count,
          // The status and route of an HTTP failure; never a response body (a message can echo anything).
          status: err instanceof OpenCodeHttpError ? err.status : undefined,
          error: err instanceof Error ? err.message : String(err),
          transient: retryable,
          attempt: failed,
          gaveUp,
        })
      }
    }
  }

  /**
   * The friction counters of every session a step ever opened: each generation of the step key (a retry opens the
   * next one) and each generation's provider-balance fallback session. Derived from the session ids, so it needs no
   * handle and no hook delivery: a retried attempt, a step replayed after a crash and a fallback all count, once, under
   * their own session id. A session whose probe fails is logged and skipped, the others still count, and the answer is
   * marked `incomplete` (a failed probe on a generation also ends the walk: whether a later one exists is unknown).
   */
  async stepFriction(step: { runId: string; stepId: string }): Promise<StepSessions> {
    const key = `${step.runId}:${step.stepId}`
    const headers = this.headers(step.runId, step.stepId)
    type Probe = { state: 'counted' | 'absent' | 'failed'; entry?: { session: string } & SessionCounters }
    const probe = async (sessionId: string): Promise<Probe> => {
      try {
        if (!(await this.client.getSession(sessionId, headers))) return { state: 'absent' }
        const messages = await this.client.messages(sessionId, headers)
        return {
          state: 'counted',
          entry: { session: sessionId, ...sessionCounters(messages, inputId(sessionId, 'prompt'), sessionId) },
        }
      } catch (err) {
        this.logger.warn('opencode friction probe failed; this session is not counted', {
          sessionId,
          error: err instanceof Error ? err.name : typeof err,
        })
        return { state: 'failed' }
      }
    }
    const counted: ({ session: string } & SessionCounters)[] = []
    let incomplete = false
    for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
      const id = sessionIdFor(key, generation)
      // A failing fallback probe never drops the primary's counters (each probe has its own try/catch).
      const [primary, fallback] = await Promise.all([probe(id), probe(fallbackSessionId(id))])
      for (const probed of [primary, fallback]) {
        if (probed.entry) counted.push(probed.entry)
        if (probed.state === 'failed') incomplete = true
      }
      if (primary.state !== 'counted') break // absent: no further generation; failed: unknown, stop probing
    }
    return { sessions: counted, incomplete }
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
    return { output: this.output(h, messages, promptId), usage: this.usage(h, messages) }
  }

  /**
   * The step's output from the answer to `promptId`: a text step's last text; a JSON step's last completed result-tool
   * call, which OpenCode validated against the step's schema. A JSON step that ended without one fails as
   * `invalid_output` (a workflow's retry re-asks it); its text is never parsed instead.
   */
  private output(h: OpenCodeHandle, messages: readonly Message[], promptId: string): Json {
    if (h.output === 'text') return finalText(messages, promptId)
    const input = submittedResult(messages, promptId, RESULT_TOOL)
    if (input !== undefined) return resultValue(h.agent, input, h.result?.wrapped === true)
    const said = finalText(messages, promptId)
    // Long enough for a workflow's salvage of an answer written as text (the review synthesis keeps it for triage).
    const text = said ? `its last text: ${JSON.stringify(said.slice(0, FAILED_TEXT_CHARS))}` : 'it wrote no text either'
    throw new WorkflowError(
      'invalid_output',
      `agent "${h.agent}" (session ${h.sessionId}) ended its turn without a completed ${RESULT_TOOL} call; ${text}`,
    )
  }

  /** Tokens from the messages (`usageFromOpenCodeMessages`), cost per message by `priceOpenCodeMessages`. */
  private usage(h: OpenCodeHandle, messages: Message[]): Usage {
    // `h.route` is the route the step was resolved from; a fallback session keeps the primary's id.
    const usage = usageFromOpenCodeMessages(messages, { model: h.model, route: h.route })
    const priced = priceOpenCodeMessages(messages, this.routeRate(h))
    return priced === null
      ? unpriced(usage)
      : { ...usage, cost: priced.cost, costSource: priced.byRate ? 'rate' : 'provider' }
  }

  private routeRate(h: OpenCodeHandle): Rate | null {
    try {
      const route = h.fallback ? this.fallbackOf(h)?.route : modelRef(h.route, patchOf(h)).route
      return route ? rateFor(route) : null
    } catch {
      return null
    }
  }
}

/**
 * The cost of a session's assistant messages, or `null` when one cannot be priced. Per message: OpenCode's when it is
 * positive (it prices with the config's cost rows, i.e. the route's base rate); a message it reports at 0 with tokens
 * is priced with the route's rate (`costFromUsage`). The exception is a message above the rate's long-prompt threshold
 * on a rate that has a tier (`longPrompt`): OpenCode's flat rows cannot know the tier, so that message is priced by the
 * rate whatever OpenCode reported. A rate without a tier is flat at any size. The threshold applies per message, never
 * to the step. `byRate`: some message was priced by the rate.
 */
export function priceOpenCodeMessages(
  messages: readonly Message[],
  rate: Rate | null,
): { cost: number; byRate: boolean } | null {
  let cost = 0
  let byRate = false
  for (const m of messages) {
    if (m.type !== 'assistant' || !m.tokens) continue
    const t = m.tokens
    const cacheRead = t.cache?.read ?? 0
    const cacheWrite = t.cache?.write ?? 0
    const total = (t.input ?? 0) + cacheRead + cacheWrite + (t.output ?? 0) + (t.reasoning ?? 0)
    if (total === 0) continue
    const tiered =
      rate?.longPrompt !== undefined &&
      (t.input ?? 0) + cacheRead + cacheWrite > (rate.longPromptTokens ?? Number.POSITIVE_INFINITY)
    if (!tiered && typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost > 0) {
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
    if (priced.usd === null) return null
    cost += priced.usd
    byRate = true
  }
  return { cost, byRate }
}

const unpriced = (usage: Usage): Usage => ({ ...usage, cost: null, costSource: 'unknown' })

/** The id of the session a step moves to when its session fails on provider balance: derived, so re-attach finds it. */
const fallbackSessionId = (sessionId: string) => sessionIdFor(`${sessionId}\0fallback`, 1)

/**
 * Whether `sessionId` is one of the sessions the host opens for the step keyed `key` (any generation, primary or
 * fallback). For a tool server outside OpenCode that must tell which step a tool call comes from.
 */
export function isStepSession(sessionId: string, key: string): boolean {
  for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
    const id = sessionIdFor(key, generation)
    if (sessionId === id || sessionId === fallbackSessionId(id)) return true
  }
  return false
}

/** Whether the turn after the prompt did anything: a tool call, or a reply with output tokens. */
function turnRan(messages: readonly Message[], promptId: string): boolean {
  const from = promptIndex(messages, promptId)
  return messages
    .slice(from + 1)
    .some(
      (m) =>
        m.type === 'assistant' &&
        ((m.content ?? []).some((p) => p.type === 'tool') || (m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0) > 0),
    )
}

/** The prompt the host sent, as the session holds it; null when it is not there. */
function promptText(messages: readonly Message[], promptId: string): string | null {
  const prompt = messages[promptIndex(messages, promptId)]
  if (!prompt) return null
  const text = prompt.text ?? (prompt.content ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
  return text || null
}

/** A follow-up turn's input id: deterministic per session and turn, so the server dedupes a re-send. */
const turnInputId = (sessionId: string, turn: string) => inputId(sessionId, 'prompt', `turn:${turn}`)

/** Where the turn's input sits in the session; -1 before it is projected. */
function turnIndex(messages: readonly Message[], id: string, turn: string): number {
  return messages.findIndex(
    (m) => m.id === id || (m.type === 'user' && (m.metadata?.agw as { turn?: unknown } | undefined)?.turn === turn),
  )
}

const INPUT_KINDS = new Set(['prompt', 'steer', 'resume', 'followup'])

/** The turn's state, as `sessionState` judges a first turn, counted from the turn's own input. */
function turnState(snap: { messages: Message[]; active: boolean; pending: boolean }, from: number): SessionState {
  if (snap.active || snap.pending) return { kind: 'running' }
  const last = snap.messages.at(-1)
  if (from < 0 || last === undefined) return { kind: 'unprompted' }
  let lastInput = from
  snap.messages.forEach((m, i) => {
    if (i > from && INPUT_KINDS.has(m.metadata?.agw?.kind ?? '')) lastInput = i
  })
  if (last.type === 'idle' && snap.messages.length - 1 > lastInput) {
    const outcome: Outcome = last.outcome ?? 'unknown'
    const error = typeof last.error === 'string' ? last.error : last.error?.message
    return error ? { kind: 'done', outcome, error } : { kind: 'done', outcome }
  }
  return { kind: 'cutoff', lastId: last.id }
}

/** The tool parts of the turn's assistant messages. */
function turnTools(after: readonly Message[]): ToolPart[] {
  return after
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => (m.content ?? []).filter((p): p is ToolPart => p.type === 'tool' && !!p.id && !!p.name))
}

/** How much of a JSON step's last text its `invalid_output` error carries when it ended without a result. */
const FAILED_TEXT_CHARS = 4_000

/** `finalText` reads after a prompt; the turn's slice gets a stand-in prompt in front. */
const TURN_ANCHOR = { id: 'agw-turn-anchor', type: 'user' } as Message
