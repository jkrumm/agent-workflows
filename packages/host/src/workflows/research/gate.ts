import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStepSession } from '@agent-workflows/opencode-host'
import type { Json, Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import { EngineJobFailed, type EngineClient, runEngineJob } from './engine.ts'
import type { LedgerEntry, ToolLedger } from './ledger.ts'
import { asRecord } from './util.ts'

/**
 * The tools a research agent may call, as the model sees them, and what each runs. The four web tools are the
 * platform's capabilities (`web.*`); `engine_research` is one quick job of research-gateway's engine (the pilot arm).
 */
export const GATE_TOOLS = ['web_search', 'web_fetch', 'web_docs', 'web_package', 'engine_research'] as const
export type GateTool = (typeof GATE_TOOLS)[number]

const CAPABILITY: Record<Exclude<GateTool, 'engine_research'>, string> = {
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
}

export type GateOptions = {
  call: CapabilityCall
  /** The engine, for `engine_research`; null when none is configured (the tool then answers an error). */
  engine: () => EngineClient | null
  /** Every call is appended here as it happens; the research step's `evidence` reads it. */
  ledger: ToolLedger
  /** `<stateDir>/research/gate.json` is where the agents' tool finds the gate. */
  stateDir: string
  /** Engine poll interval for `engine_research`; tests shorten it. */
  enginePollMs?: number
  /** Whether a session belongs to a step: the OpenCode host's deterministic session ids; tests swap it. */
  belongsTo?: (sessionId: string, stepKey: string) => boolean
}

/** Byte cap of a tool call's body: arguments are a query, a URL or a question. Checked before anything is buffered. */
export const MAX_BODY_BYTES = 64 * 1024

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

/**
 * The research agents' only way out to the web: a loopback HTTP server that runs the `web.*` capabilities (and the
 * engine's quick job) for a session the research workflow has granted, and nothing else.
 *
 * Why not `agw web …` from a shell: an agent reading untrusted pages must not hold a shell, and a shell reaches the
 * host's full API secret on disk. Here the agent holds nothing: its tool (an OpenCode plugin in its location) reads the
 * gate's key from a 0600 file outside every location (the sessions deny `external_directory`), and the key only opens
 * this server, whose only verbs are the granted tools, only for the sessions of a step that is running now.
 *
 * The gate keeps no evidence itself: every call goes to the ledger (Postgres on the host) as it happens, keyed by run
 * and step, so a step retry, a resume or a host restart reads the same calls. Grants live only while their step runs.
 */
export class ToolGate {
  private readonly grants = new Map<string, Grant>()
  private readonly bySession = new Map<string, Grant>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly key = randomBytes(32).toString('hex')

  constructor(private readonly options: GateOptions) {}

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
    }
    return { url: this.url() }
  }

  private url(): string {
    return `http://127.0.0.1:${this.server?.port}`
  }

  /**
   * Grants step `stepId` of run `runId` the `tools` until the returned close (call it in a `finally`: a cancelled run
   * leaves no grant behind). A second grant for the same step (a resumed run) replaces the first.
   */
  open(input: { runId: string; stepId: string; tools: readonly GateTool[] }): () => void {
    this.ensureServing()
    const stepKey = `${input.runId}:${input.stepId}`
    const previous = this.grants.get(stepKey)
    if (previous) this.drop(previous)
    const grant: Grant = {
      runId: input.runId,
      stepId: input.stepId,
      stepKey,
      tools: new Set(input.tools),
      controller: new AbortController(),
    }
    this.grants.set(stepKey, grant)
    return () => {
      if (this.grants.get(stepKey) === grant) this.drop(grant)
    }
  }

  private drop(grant: Grant) {
    grant.controller.abort(new Error('the research step ended'))
    this.grants.delete(grant.stepKey)
    for (const [id, owner] of this.bySession) if (owner === grant) this.bySession.delete(id)
  }

  /** Ends every grant, stops the server and removes `gate.json`. The host calls it on shutdown. */
  close() {
    for (const grant of [...this.grants.values()]) this.drop(grant)
    void this.server?.stop(true)
    this.server = null
    rmSync(this.file, { force: true })
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

  /** The HTTP door: `POST /tool/<name>` with `{sessionID, args}`; answers `{ok, result}` or `{ok: false, error}`. */
  async handle(req: Request): Promise<Response> {
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
    const base = {
      runId: grant.runId,
      stepId: grant.stepId,
      tool,
      argsDigest: digest(JSON.stringify(call.args)),
    }
    const usage: Usage[] = []
    try {
      const { result, entry } = await this.run(grant, tool, call.args, usage)
      await this.options.ledger.append({ ...base, ok: true, retrieved: [], seen: [], usage, ...entry })
      return answer(200, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed: LedgerEntry = { ...base, ok: false, retrieved: [], seen: [], usage, error: message.slice(0, 300) }
      if (error instanceof EngineJobFailed) {
        failed.engineJob = error.jobId
        failed.engineCostUsd = error.costUsd
        failed.usage = [engineUsage(error.costUsd)]
      }
      await this.options.ledger.append(failed)
      return answer(200, { ok: false, error: message.slice(0, 1_000) })
    }
  }

  private async run(
    grant: Grant,
    tool: GateTool,
    args: Record<string, Json>,
    usage: Usage[],
  ): Promise<{ result: Json; entry: Partial<LedgerEntry> }> {
    const signal = grant.controller.signal
    if (tool === 'engine_research') return this.engineResearch(grant, args)
    const output = await this.options.call(CAPABILITY[tool], args, { addUsage: (u) => usage.push(u), signal })
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
        usage: [engineUsage(costUsd)],
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

/** What a step's recorded calls add up to: URLs retrieved and seen (normalized), failed fetches, engine jobs and cost. */
export function evidence(entries: LedgerEntry[]) {
  const retrieved = new Set<string>()
  const seen = new Set<string>()
  const counts: Record<string, number> = {}
  let failed = 0
  const engineJobs: string[] = []
  let engineCostUsd: number | null = null
  let engineUnpriced = false
  for (const entry of entries) {
    for (const url of entry.retrieved) retrieved.add(normalizeUrl(url))
    for (const url of entry.seen) seen.add(normalizeUrl(url))
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
    if (!entry.ok && entry.tool === 'web_fetch') failed++
    if (entry.engineJob) {
      engineJobs.push(entry.engineJob)
      if (typeof entry.engineCostUsd === 'number') engineCostUsd = (engineCostUsd ?? 0) + entry.engineCostUsd
      else engineUnpriced = true
    }
  }
  return { retrieved, seen, failed, counts, engineJobs, engineCostUsd: engineUnpriced ? null : engineCostUsd }
}
