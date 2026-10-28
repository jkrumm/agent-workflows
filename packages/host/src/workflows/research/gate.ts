import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStepSession } from '@agent-workflows/opencode-host'
import type { Json, Logger, Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import { canonicalJson } from '../../canonical.ts'
import { type EngineClient, EngineJobFailed, runEngineJob } from './engine.ts'
import type { LedgerEntry, ToolLedger } from './ledger.ts'
import { asRecord } from './util.ts'

/**
 * The tools a research agent may call, as the model sees them, and what each runs. The four web tools are the
 * platform's capabilities (`web.*`); `engine_research` is one quick job of research-gateway's engine (the pilot arm).
 */
export const GATE_TOOLS = ['web_search', 'web_fetch', 'web_docs', 'web_package', 'engine_research'] as const
export type GateTool = (typeof GATE_TOOLS)[number]

export const CAPABILITY: Record<Exclude<GateTool, 'engine_research'>, string> = {
  web_search: 'web.search',
  web_fetch: 'web.fetch',
  web_docs: 'web.docs',
  web_package: 'web.package',
}

/** How the gate runs a capability: the host's registry, in process. */
export type CapabilityCall = (
  id: string,
  input: Json,
  options: { addUsage: (usage: Usage) => void; signal: AbortSignal },
) => Promise<Json>

type Grant = {
  runId: string
  stepId: string
  stepKey: string
  tools: ReadonlySet<GateTool>
  controller: AbortController
  /** Calls still being served: a drop waits for them, so every row is written before `tools` reads. */
  inflight: Set<Promise<unknown>>
  /** Where a call's usage is booked: the research run's `tools` step, once it is bound; held here until then. */
  sink: ((usage: Usage) => void) | null
  held: Usage[]
  /** Engine jobs booked in this process (two calls in flight on one question); the ledger answers across processes. */
  bookedJobs: Set<string>
}

export type GateOptions = {
  call: CapabilityCall
  /** The engine, for `engine_research`; null when none is configured (the tool then answers an error). */
  engine: () => EngineClient | null
  /** Every call is appended here as it happens: the evidence the research step's `tools` reads. */
  ledger: ToolLedger
  /** `<stateDir>/research/gate.json` is where the agents' tool finds the gate. */
  stateDir: string
  /** Engine poll interval for `engine_research`; tests shorten it. */
  enginePollMs?: number
  /** Whether a session belongs to a step: the OpenCode host's deterministic session ids; tests swap it. */
  belongsTo?: (sessionId: string, stepKey: string) => boolean
  logger?: Logger
  /** How long a drop waits for calls still in flight (after aborting them). Default 10 s. */
  drainMs?: number
}

/** Byte cap of a tool call's body: arguments are a query, a URL or a question. Checked before anything is buffered. */
export const MAX_BODY_BYTES = 64 * 1024
/** Ledger writes per call: a blip is retried, a lasting failure is logged and the call's answer stands. */
const APPEND_ATTEMPTS = 3

/** `https://Example.com/a/#x` and `https://example.com/a` are the same page for grounding. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : ''
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim()
  }
}

const ToolCall = z.object({ sessionID: z.string().min(1), args: z.record(z.string(), z.json()).default({}) })

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
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

type Served =
  | { ok: true; result: Json; entry: Partial<LedgerEntry> }
  | { ok: false; error: string; entry: Partial<LedgerEntry> }

/**
 * The research agents' only way out to the web: a loopback HTTP server that runs the `web.*` capabilities (and the
 * engine's quick job) for a session the research workflow has granted, and nothing else.
 *
 * Why not `agw web …` from a shell: an agent reading untrusted pages must not hold a shell, and a shell reaches the
 * host's full API secret on disk. Here the agent holds nothing: its tool (an OpenCode plugin in its location) reads the
 * gate's key from a 0600 file outside every location (the sessions deny `external_directory`), and the key only opens
 * this server, whose only verbs are the granted tools, only for the sessions of a step that is running now.
 *
 * Two outputs per call, kept apart: its usage is booked on the research run as it is reported (the grant's sink, the
 * run's `tools` step), and its evidence (URLs, ok or error, engine job) is written to the ledger. A ledger write that
 * fails is retried and logged; it never turns a call that worked into a failed one.
 */
export class ToolGate {
  private readonly grants = new Map<string, Grant>()
  private readonly bySession = new Map<string, Grant>()
  private server: ReturnType<typeof Bun.serve> | null = null
  /** Set once this instance wrote `gate.json`: only then does `close` remove it (another host may own the file). */
  private wroteFile = false
  private readonly key = randomBytes(32).toString('hex')
  private readonly logger: Logger

  constructor(private readonly options: GateOptions) {
    this.logger = options.logger ?? silent
  }

  private get file() {
    return join(this.options.stateDir, 'research', 'gate.json')
  }

  /** Starts the server on first use and (re)writes `gate.json`; idempotent. */
  ensureServing(): { url: string } {
    if (!this.server) {
      // No idle timeout: `engine_research` holds its request for a whole engine job (10-60 s; Bun's default cuts at 10 s).
      this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) })
      mkdirSync(join(this.options.stateDir, 'research'), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ url: this.url(), key: this.key })}\n`, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
      this.wroteFile = true
    }
    return { url: this.url() }
  }

  private url(): string {
    return `http://127.0.0.1:${this.server?.port}`
  }

  /**
   * Grants step `stepId` of run `runId` the `tools` until the returned close, which aborts and awaits (bounded) the
   * calls still in flight. Call it in a `finally`: a cancelled run leaves no grant behind. A second grant for the same
   * step (a resumed run) replaces the first.
   */
  open(input: { runId: string; stepId: string; tools: readonly GateTool[] }): () => Promise<void> {
    this.ensureServing()
    const stepKey = `${input.runId}:${input.stepId}`
    const previous = this.grants.get(stepKey)
    if (previous) void this.drop(previous)
    const grant: Grant = {
      runId: input.runId,
      stepId: input.stepId,
      stepKey,
      tools: new Set(input.tools),
      controller: new AbortController(),
      inflight: new Set(),
      sink: null,
      held: [],
      bookedJobs: new Set(),
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

  /** Waits (bounded) until the step's calls in flight are served. */
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
    grant.controller.abort(new Error('the research step ended'))
    await this.drain(grant)
  }

  /**
   * Ends every grant (awaiting their calls), stops the server and removes the `gate.json` this instance wrote, never
   * one another process wrote. The host calls it on shutdown.
   */
  async close() {
    await Promise.all([...this.grants.values()].map((grant) => this.drop(grant)))
    void this.server?.stop(true)
    this.server = null
    if (this.wroteFile) rmSync(this.file, { force: true })
    this.wroteFile = false
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

  /** The HTTP door: `POST /tool/<name>` with `{sessionID, args}`. Always a JSON answer, `{ok, result}` or `{ok: false, error}`. */
  async handle(req: Request): Promise<Response> {
    try {
      return await this.route(req)
    } catch (error) {
      this.logger.error('research tool gate: request failed', { error: message(error) })
      return Response.json({ ok: false, error: 'the tool gate failed on this call' }, { status: 500 })
    }
  }

  private async route(req: Request): Promise<Response> {
    const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status })
    if (!this.authorized(req.headers.get('authorization'))) return answer(401, { ok: false, error: 'unauthorized' })
    const name = /^\/tool\/([a-z_]+)$/.exec(new URL(req.url).pathname)?.[1]
    if (req.method !== 'POST' || !name) return answer(404, { ok: false, error: 'not found' })
    if (!(GATE_TOOLS as readonly string[]).includes(name)) return answer(404, { ok: false, error: `no tool ${name}` })
    const tool = name as GateTool
    const raw = await readCapped(req, MAX_BODY_BYTES)
    if (raw === null) return answer(413, { ok: false, error: `request larger than ${MAX_BODY_BYTES} bytes` })
    let call: z.output<typeof ToolCall>
    try {
      call = ToolCall.parse(JSON.parse(raw))
    } catch {
      return answer(400, { ok: false, error: 'expected {sessionID, args}' })
    }
    const grant = this.grantOf(call.sessionID)
    if (!grant) return answer(403, { ok: false, error: 'this session holds no research grant' })
    if (!grant.tools.has(tool)) return answer(403, { ok: false, error: `${tool} is not granted to this agent` })
    const work = this.serve(grant, tool, call.args)
    grant.inflight.add(work)
    try {
      return answer(200, await work)
    } finally {
      grant.inflight.delete(work)
    }
  }

  /** One call: run it (its usage booked as reported), then record its evidence apart. Never throws. */
  private async serve(grant: Grant, tool: GateTool, args: Record<string, Json>): Promise<Record<string, unknown>> {
    let served: Served
    try {
      served = { ok: true, ...(await this.run(grant, tool, args)) }
    } catch (error) {
      const entry: Partial<LedgerEntry> = {}
      if (error instanceof EngineJobFailed) {
        entry.engineJob = error.jobId
        entry.engineCostUsd = error.costUsd
        await this.bookEngine(grant, error.jobId, error.costUsd)
      }
      served = { ok: false, error: message(error), entry }
    }
    await this.record({
      runId: grant.runId,
      stepId: grant.stepId,
      tool,
      argsDigest: digest(canonicalJson(args)),
      ok: served.ok,
      retrieved: [],
      seen: [],
      ...served.entry,
      ...(served.ok ? {} : { error: served.error.slice(0, 300) }),
    })
    return served.ok ? { ok: true, result: served.result } : { ok: false, error: served.error.slice(0, 1_000) }
  }

  /** The ledger write, retried a bounded number of times; a lasting failure is logged and loses only evidence. */
  private async record(entry: LedgerEntry) {
    for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt++) {
      try {
        await this.options.ledger.append(entry)
        return
      } catch (error) {
        if (attempt === APPEND_ATTEMPTS) {
          this.logger.error('research tool gate: the ledger write failed; the call stands without its evidence row', {
            runId: entry.runId,
            tool: entry.tool,
            error: message(error),
          })
          return
        }
        await Bun.sleep(100 * attempt)
      }
    }
  }

  private book(grant: Grant, usage: Usage) {
    if (grant.sink) grant.sink(usage)
    else grant.held.push(usage)
  }

  /**
   * An engine job's cost, booked once: not when this process booked it already (a repeated question in flight), nor
   * when the ledger already holds the job (an earlier call adopted or ran it). A ledger that cannot be read books it.
   */
  private async bookEngine(grant: Grant, jobId: string, costUsd: number | null) {
    if (grant.bookedJobs.has(jobId)) return
    grant.bookedJobs.add(jobId)
    const known = await this.options.ledger.read(grant.runId, grant.stepId).catch(() => [])
    if (known.some((entry) => entry.engineJob === jobId)) return
    this.book(grant, engineUsage(costUsd))
  }

  private async run(
    grant: Grant,
    tool: GateTool,
    args: Record<string, Json>,
  ): Promise<{ result: Json; entry: Partial<LedgerEntry> }> {
    const signal = grant.controller.signal
    if (tool === 'engine_research') return this.engineResearch(grant, args)
    const output = await this.options.call(CAPABILITY[tool], args, { addUsage: (u) => this.book(grant, u), signal })
    const out = asRecord(output)
    const entry: Partial<LedgerEntry> = {}
    if (tool === 'web_search') {
      entry.seen = (Array.isArray(out.results) ? out.results : []).flatMap((r) => {
        const url = asRecord(r).url
        return typeof url === 'string' ? [url] : []
      })
    } else if (tool === 'web_fetch') {
      entry.retrieved = [args.url, out.url, out.finalUrl].filter((u): u is string => typeof u === 'string')
    } else if (tool === 'web_package' && typeof out.url === 'string') {
      entry.retrieved = [out.url]
    } else if (tool === 'web_docs' && typeof out.source === 'string' && /^https?:/.test(out.source)) {
      entry.retrieved = [out.source]
    }
    return { result: output, entry }
  }

  /** One quick engine job per question; the engine's sources are pages it retrieved, so they count as retrieved here. */
  private async engineResearch(
    grant: Grant,
    args: Record<string, Json>,
  ): Promise<{ result: Json; entry: Partial<LedgerEntry> }> {
    const engine = this.options.engine()
    if (!engine) throw new Error('no research engine is configured')
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (question.length < 3) throw new Error('engine_research needs a question')
    const { jobId, report } = await runEngineJob(
      engine,
      { query: question, depth: 'quick', idempotencyKey: `${grant.stepKey}:engine:${digest(question).slice(0, 16)}` },
      { signal: grant.controller.signal, ...(this.options.enginePollMs ? { pollMs: this.options.enginePollMs } : {}) },
    )
    const cost = report.cost?.totalUsd
    const costUsd = typeof cost === 'number' ? cost : null
    await this.bookEngine(grant, jobId, costUsd)
    return {
      result: {
        report: report.report,
        citations: report.citations,
        sources: report.sources,
        unverified: report.unverified,
        status: report.status,
      },
      entry: {
        retrieved: [...report.sources, ...report.citations.map((c) => c.url)],
        engineJob: jobId,
        engineCostUsd: costUsd,
      },
    }
  }
}

const zeroTokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 }

/** An engine job's spend as one usage report: its `cost.totalUsd` (LLM and search), unpriced when it reported none. */
export function engineUsage(costUsd: number | null | undefined): Usage {
  const priced = typeof costUsd === 'number' && Number.isFinite(costUsd)
  return {
    model: 'research-gateway',
    tokens: zeroTokens,
    cost: priced ? costUsd : null,
    costSource: priced ? 'provider' : 'unknown',
  }
}

/**
 * What a step's recorded calls add up to: URLs retrieved and seen (normalized), failed fetches, calls per tool, the
 * engine jobs and their cost (each job once; null when none ran or any job's cost is unknown).
 */
export function evidence(entries: LedgerEntry[]) {
  const retrieved = new Set<string>()
  const seen = new Set<string>()
  const counts: Record<string, number> = {}
  const jobs = new Map<string, number | null>()
  let failed = 0
  for (const entry of entries) {
    for (const url of entry.retrieved) retrieved.add(normalizeUrl(url))
    for (const url of entry.seen) seen.add(normalizeUrl(url))
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
    if (!entry.ok && entry.tool === 'web_fetch') failed++
    if (entry.engineJob && !jobs.has(entry.engineJob)) jobs.set(entry.engineJob, entry.engineCostUsd ?? null)
  }
  const costs = [...jobs.values()]
  const engineCostUsd =
    costs.length && costs.every((c) => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null
  return { retrieved, seen, failed, counts, engineJobs: [...jobs.keys()], engineCostUsd }
}
