import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGENT_SAFE_HDX } from '@agent-workflows/capabilities'
import { isStepSession } from '@agent-workflows/opencode-host'
import type { Json, Logger, Usage } from '@agent-workflows/runtime'
import { z } from 'zod'

/** How the gate runs a capability: the host's registry, in process. */
export type CapabilityCall = (
  id: string,
  input: Json,
  options: { addUsage: (usage: Usage) => void; signal: AbortSignal },
) => Promise<Json>

/** What a workflow's hook is told about each call it granted: the arguments and how the capability answered. */
export type ToolCallRecord = {
  runId: string
  stepId: string
  tool: string
  args: Record<string, Json>
  /** What `onStart` returned for this call: the label the agent was shown with the answer. */
  label?: string
  outcome: { ok: true; result: Json } | { ok: false; error: string }
}

/**
 * What a workflow grants one of its steps: the tools the step's agent may call, as the model names them, each mapped
 * to the capability it runs; and an optional hook told of every call once it has been answered (research records the
 * URLs a call retrieved or saw). The hook runs inside the call's in-flight window, so a drain waits for it. It should
 * not throw; one that does is logged and the call's answer stands. `fixed` arguments are set on every call after the
 * agent's own, so a value the run decides (otel's environment) is not the agent's to choose; the hook sees the
 * arguments as they ran.
 */
export type ToolGrant = {
  runId: string
  stepId: string
  tools: Readonly<Record<string, string>>
  fixed?: Readonly<Record<string, Json>>
  /**
   * Told of each call as it starts, after the grant check and before the capability runs, in the order calls arrive;
   * the string it returns is the call's `label`: sent back with the answer (`label` next to `result` or `error`),
   * where the agent's tool shows it, and passed to `onCall`. Otel numbers its queries this way, so the ids an agent
   * cites are the ones the run recorded. It must not throw; one that does is logged and the call runs unlabeled.
   */
  onStart?: (call: { runId: string; stepId: string; tool: string; args: Record<string, Json> }) => string | undefined
  onCall?: (call: ToolCallRecord) => void | Promise<void>
}

/** Why the gate refused a call, as the plugin's JSON answer carries it in `code`. */
export type GateRefusal = 'unauthorized' | 'not_found' | 'too_large' | 'bad_request' | 'no_grant' | 'not_granted'

type Grant = {
  runId: string
  stepId: string
  stepKey: string
  tools: Readonly<Record<string, string>>
  fixed: Readonly<Record<string, Json>>
  onStart: ToolGrant['onStart']
  onCall: ToolGrant['onCall']
  controller: AbortController
  /** Calls still being served: a drop waits for them, so every row is written before a step reads its evidence. */
  inflight: Set<Promise<unknown>>
  /** Where a call's usage is booked: the step's own usage, once it is bound; held here until then. */
  sink: ((usage: Usage) => void) | null
  held: Usage[]
  dropped: boolean
}

export type GateOptions = {
  call: CapabilityCall
  /** `<stateDir>/gate.json` is where every agent's tool plugin finds the gate. */
  stateDir: string
  /** Whether a session belongs to a step: the OpenCode host's deterministic session ids; tests swap it. */
  belongsTo?: (sessionId: string, stepKey: string) => boolean
  logger?: Logger
  /** How long a drop waits for calls still in flight (after aborting them). Default 10 s. */
  drainMs?: number
}

/** Byte cap of a tool call's body: arguments are a query, a URL or a question. Checked before anything is buffered. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Where the previous release's plugins look for the gate (relative to `stateDir`). A run resumed across a deploy
 * re-attaches to a session in its old content-hashed location, whose plugin still reads this path, so for this release
 * the gate writes it too, with the same url and key. Dropped in a later release, once no live location reads it.
 */
const LEGACY_FILES = [join('research', 'gate.json')]

const ToolCall = z.object({ sessionID: z.string().min(1), args: z.record(z.string(), z.json()).default({}) })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The body as text, refused past `max` bytes by its declared length or while it streams; null when too large. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const silent: Logger = { warn: () => {}, error: () => {} }

/**
 * An agent's only way out of its sandbox: a loopback HTTP server that runs platform capabilities for a session a
 * workflow has granted, and nothing else. One per host process; every workflow that gives an agent tools opens a
 * grant on it with its own tool set.
 *
 * Why not `agw …` from a shell: an agent reading untrusted input (web pages, logs, notes) must not hold a shell, and a
 * shell reaches the host's full API secret on disk. Here the agent holds nothing: its tools (an OpenCode plugin in its
 * location) read the gate's key from a 0600 file outside every location (the sessions deny `external_directory`), and
 * the key only opens this server, whose only verbs are the tools of a grant, only for the sessions of a step that is
 * running now. A tool outside the session's own grant is refused before any capability is reached; so is a session
 * with no grant, and one run's session never resolves to another run's grant.
 *
 * Two outputs per call, kept apart: its usage is booked on the granting step as it is reported (`bindUsage`), and the
 * workflow's `onCall` hook sees the outcome to record its own evidence.
 */
export class ToolGate {
  private readonly grants = new Map<string, Grant>()
  private readonly bySession = new Map<string, Grant>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly key = randomBytes(32).toString('hex')
  private readonly logger: Logger
  private lookup: ((id: string) => { mutating: boolean } | undefined) | null = null

  constructor(private readonly options: GateOptions) {
    this.logger = options.logger ?? silent
  }

  /** Every path the gate's address and key are written to: `<stateDir>/gate.json`, then the legacy ones. */
  private get files() {
    return ['gate.json', ...LEGACY_FILES].map((name) => join(this.options.stateDir, name))
  }

  /**
   * Starts the server on first use and (re)writes the gate files; idempotent. A write that fails stops the server
   * again and throws, so the next call retries from scratch rather than serving with no file for the agents to read.
   */
  ensureServing(): { url: string } {
    if (!this.server) {
      // No idle timeout: a capability call may hold its request past Bun's default 10 s cut; the grant's abort ends it.
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) })
      try {
        const content = `${JSON.stringify({ url: `http://127.0.0.1:${server.port}`, key: this.key })}\n`
        for (const file of this.files) this.writeFile(file, content)
      } catch (error) {
        void server.stop(true)
        throw error
      }
      this.server = server
    }
    return { url: this.url() }
  }

  private writeFile(file: string, content: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, content, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  }

  private url(): string {
    return `http://127.0.0.1:${this.server?.port}`
  }

  /**
   * Teaches the gate what the host's capabilities are (`mutating` is the CLI spec's flag; `undefined`: no such
   * capability). `createWorkflows` calls it with the registry it serves, before any run: from then on `open` refuses a
   * grant of a mutating or unknown capability. Until it is called only the `hdx.*` name rule holds, which is how
   * tests with fake capabilities run.
   */
  setCapabilities(lookup: (id: string) => { mutating: boolean } | undefined) {
    this.lookup = lookup
  }

  /** Why a grant of `capability` to an agent is refused, or null. Structural: no workflow's prose can widen it. */
  private refusal(capability: string): string | null {
    if (capability.startsWith('hdx.') && !(AGENT_SAFE_HDX as readonly string[]).includes(capability)) {
      return `${capability} is not agent-safe (hdx grants draw from AGENT_SAFE_HDX)`
    }
    if (!this.lookup) return null
    const spec = this.lookup(capability)
    if (!spec) return `${capability} is not a capability of this host`
    return spec.mutating ? `${capability} is mutating` : null
  }

  /**
   * Grants step `stepId` of run `runId` its tools until the returned close, which aborts and awaits (bounded) the
   * calls still in flight. Call it in a `finally`: a cancelled run leaves no grant behind. A second grant for the same
   * step (a resumed run) replaces the first. A grant that maps a tool to a mutating or unknown capability, or to an
   * `hdx.*` capability outside `AGENT_SAFE_HDX`, throws before anything is opened: an agent holds read tools only.
   */
  open(input: ToolGrant): () => Promise<void> {
    for (const [tool, capability] of Object.entries(input.tools)) {
      const reason = this.refusal(capability)
      if (reason) throw new Error(`tool grant refused: ${tool} -> ${reason}`)
    }
    this.ensureServing()
    const stepKey = `${input.runId}:${input.stepId}`
    const previous = this.grants.get(stepKey)
    if (previous) void this.drop(previous)
    const grant: Grant = {
      runId: input.runId,
      stepId: input.stepId,
      stepKey,
      tools: { ...input.tools },
      fixed: { ...input.fixed },
      onStart: input.onStart,
      onCall: input.onCall,
      controller: new AbortController(),
      inflight: new Set(),
      sink: null,
      held: [],
      dropped: false,
    }
    this.grants.set(stepKey, grant)
    return () => (this.grants.get(stepKey) === grant ? this.drop(grant) : Promise.resolve())
  }

  /** Books the step's call usage into `addUsage` from now on (and what was held until now); returns the unbind. */
  bindUsage(runId: string, stepId: string, addUsage: (usage: Usage) => void): () => void {
    const grant = this.grants.get(`${runId}:${stepId}`)
    if (!grant) return () => {}
    grant.sink = addUsage
    for (const usage of grant.held.splice(0)) addUsage(usage)
    return () => {
      if (grant.sink === addUsage) grant.sink = null
    }
  }

  /**
   * Waits (bounded) for the step's calls in flight, before its grant is closed: a call the agent made last finishes,
   * books its cost and runs its hook. One still running at the bound is aborted by the close.
   */
  async settle(runId: string, stepId: string): Promise<void> {
    const grant = this.grants.get(`${runId}:${stepId}`)
    if (grant) await this.drain(grant)
  }

  private async drain(grant: Grant) {
    if (grant.inflight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, this.options.drainMs ?? 10_000)
    })
    await Promise.race([Promise.allSettled([...grant.inflight]), timeout])
    clearTimeout(timer)
  }

  private async drop(grant: Grant) {
    this.grants.delete(grant.stepKey)
    for (const [id, owner] of this.bySession) if (owner === grant) this.bySession.delete(id)
    grant.controller.abort(new Error('the tool grant ended'))
    await this.drain(grant)
    grant.dropped = true
    this.reportLost(grant)
  }

  /** Usage no step took (booked while unbound, or after the grant ended) is logged, never dropped silently. */
  private reportLost(grant: Grant) {
    if (grant.held.length === 0) return
    const lost = grant.held.splice(0)
    this.logger.error('tool gate: usage booked on a step that was not bound to take it', {
      runId: grant.runId,
      stepId: grant.stepId,
      calls: lost.length,
      cost: lost.reduce((sum, usage) => sum + (usage.cost ?? 0), 0),
    })
  }

  /**
   * Ends every grant (awaiting their calls), stops the server and removes each gate file that still holds this
   * instance's key: never a file another host wrote, before or after this one. The host calls it on shutdown.
   */
  async close() {
    await Promise.all([...this.grants.values()].map((grant) => this.drop(grant)))
    void this.server?.stop(true)
    this.server = null
    for (const file of this.files) if (this.owns(file)) rmSync(file, { force: true })
  }

  private owns(file: string): boolean {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown }).key === this.key
    } catch {
      return false // gone, or not ours to read
    }
  }

  private grantOf(sessionId: string): Grant | null {
    const known = this.bySession.get(sessionId)
    if (known && this.grants.get(known.stepKey) === known) return known
    for (const grant of this.grants.values()) {
      if (!(this.options.belongsTo ?? isStepSession)(sessionId, grant.stepKey)) continue
      this.bySession.set(sessionId, grant)
      return grant
    }
    return null
  }

  private authorized(header: string | null): boolean {
    const given = /^Bearer +(\S+)$/i.exec(header ?? '')?.[1] ?? ''
    return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(this.key).digest())
  }

  /** The HTTP door: `POST /tool/<name>` with `{sessionID, args}`. Always a JSON answer, `{ok, result}` or `{ok: false, error, code?}`. */
  async handle(req: Request): Promise<Response> {
    try {
      return await this.route(req)
    } catch (error) {
      this.logger.error('tool gate: request failed', { error: message(error) })
      return Response.json({ ok: false, error: 'the tool gate failed on this call' }, { status: 500 })
    }
  }

  private async route(req: Request): Promise<Response> {
    const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status })
    const refuse = (status: number, code: GateRefusal, error: string) => answer(status, { ok: false, error, code })
    if (!this.authorized(req.headers.get('authorization'))) return refuse(401, 'unauthorized', 'unauthorized')
    const tool = /^\/tool\/([a-z_]+)$/.exec(new URL(req.url).pathname)?.[1]
    if (req.method !== 'POST' || !tool) return refuse(404, 'not_found', 'not found')
    const raw = await readCapped(req, MAX_BODY_BYTES)
    if (raw === null) return refuse(413, 'too_large', `request larger than ${MAX_BODY_BYTES} bytes`)
    let call: z.output<typeof ToolCall>
    try {
      call = ToolCall.parse(JSON.parse(raw))
    } catch {
      return refuse(400, 'bad_request', 'expected {sessionID, args}')
    }
    const grant = this.grantOf(call.sessionID)
    if (!grant) return refuse(403, 'no_grant', 'this session holds no tool grant')
    const capability = Object.hasOwn(grant.tools, tool) ? grant.tools[tool] : undefined
    if (capability === undefined) return refuse(403, 'not_granted', `${tool} is not granted to this agent`)
    const args = { ...call.args, ...grant.fixed }
    const label = this.label(grant, tool, args)
    const work = this.serve(grant, tool, capability, args, label)
    grant.inflight.add(work)
    try {
      return answer(200, await work)
    } finally {
      grant.inflight.delete(work)
    }
  }

  private label(grant: Grant, tool: string, args: Record<string, Json>): string | undefined {
    try {
      return grant.onStart?.({ runId: grant.runId, stepId: grant.stepId, tool, args })
    } catch (error) {
      this.logger.error('tool gate: the start hook failed; the call runs unlabeled', {
        runId: grant.runId,
        tool,
        error: message(error),
      })
      return undefined
    }
  }

  /** One call: run its capability (usage booked as reported), then tell the hook apart. Never throws. */
  private async serve(
    grant: Grant,
    tool: string,
    capability: string,
    args: Record<string, Json>,
    label: string | undefined,
  ): Promise<Record<string, unknown>> {
    let outcome: ToolCallRecord['outcome']
    try {
      const result = await this.options.call(capability, args, {
        addUsage: (usage) => this.book(grant, usage),
        signal: grant.controller.signal,
      })
      outcome = { ok: true, result }
    } catch (error) {
      outcome = { ok: false, error: message(error) }
    }
    try {
      await grant.onCall?.({
        runId: grant.runId,
        stepId: grant.stepId,
        tool,
        args,
        ...(label ? { label } : {}),
        outcome,
      })
    } catch (error) {
      this.logger.error('tool gate: the call hook failed; the call stands', {
        runId: grant.runId,
        tool,
        error: message(error),
      })
    }
    const tag = label ? { label } : {}
    return outcome.ok
      ? { ok: true, result: outcome.result, ...tag }
      : { ok: false, error: outcome.error.slice(0, 1_000), ...tag }
  }

  private book(grant: Grant, usage: Usage) {
    if (grant.sink) grant.sink(usage)
    else grant.held.push(usage)
    if (grant.dropped) this.reportLost(grant) // a call that outlived its grant's drain: nothing will bind again
  }
}
