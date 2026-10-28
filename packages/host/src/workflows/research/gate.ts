import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStepSession } from '@agent-workflows/opencode-host'
import type { Json, Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type EngineClient, runEngineJob } from './engine.ts'

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

/** How the gate runs a capability: the host's registry, in process, with the usage collected per grant. */
export type CapabilityCall = (
  id: string,
  input: Json,
  options: { addUsage: (usage: Usage) => void; signal: AbortSignal },
) => Promise<Json>

/** One tool call as the ledger keeps it: what it retrieved (page text read) and saw (search results, snippets). */
export type LedgerEntry = { tool: GateTool; ok: boolean; retrieved: string[]; seen: string[]; error?: string }

/** What a grant collected, read once the agent step has ended. */
export type GrantRecord = {
  entries: LedgerEntry[]
  usage: Usage[]
  engineJobs: string[]
  engineCostUsd: number | null
}

type Grant = {
  runId: string
  stepKey: string
  depth: string
  tools: ReadonlySet<GateTool>
  record: GrantRecord
  sessions: Set<string>
  controller: AbortController
}

export type GateOptions = {
  call: CapabilityCall
  /** The engine, for `engine_research`; null when none is configured (the tool then answers an error). */
  engine: () => EngineClient | null
  /** `<stateDir>/research/gate.json` is where the agents' tool finds the gate. */
  stateDir: string
  /** Engine poll interval for `engine_research`; tests shorten it. */
  enginePollMs?: number
  /** Whether a session belongs to a step: the OpenCode host's deterministic session ids; tests swap it. */
  belongsTo?: (sessionId: string, stepKey: string) => boolean
}

const emptyRecord = (): GrantRecord => ({ entries: [], usage: [], engineJobs: [], engineCostUsd: null })

/** Body cap of a tool call: arguments are a query, a URL or a question. */
const MAX_BODY = 64 * 1024

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

const record = (value: Json | undefined): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

const ToolCall = z.object({ sessionID: z.string().min(1), args: z.record(z.string(), z.json()).default({}) })

/**
 * The research agents' only way out to the web: a loopback HTTP server that runs the `web.*` capabilities (and the
 * engine's quick job) for a session the research workflow has granted, and nothing else.
 *
 * Why not `agw web …` from a shell: an agent reading untrusted pages must not hold a shell, and a shell reaches the host's
 * full API secret on disk. Here the agent holds nothing: its tool (an OpenCode plugin in its location) reads the gate's
 * key from a 0600 file outside every location (the sessions deny `external_directory`), and the key only opens this
 * server, whose only verbs are the granted tools, only for the sessions of a step that is running now. A grant is
 * in memory: after a host restart the resumed workflow grants again, and what the tools collected before the restart
 * is not in the ledger (its cost included); the port persists it.
 */
export class ToolGate {
  private readonly grants = new Map<string, Grant>()
  private readonly bySession = new Map<string, Grant>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly key = randomBytes(32).toString('hex')

  constructor(private readonly options: GateOptions) {}

  /** Starts the server on first use and (re)writes `gate.json`; idempotent. */
  ensureServing(): { url: string } {
    if (!this.server) {
      this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.handle(req) })
      const dir = join(this.options.stateDir, 'research')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, 'gate.json')
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ url: this.url(), key: this.key })}\n`, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, path)
    }
    return { url: this.url() }
  }

  private url(): string {
    return `http://127.0.0.1:${this.server?.port}`
  }

  /**
   * Grants step `stepKey` of run `runId` the `tools`, until the returned close. A second grant for the same step (a
   * resumed run) replaces the first and keeps its ledger.
   */
  open(input: { runId: string; stepKey: string; depth: string; tools: readonly GateTool[] }): () => void {
    this.ensureServing()
    const previous = this.grants.get(input.stepKey)
    if (previous) this.drop(previous)
    const grant: Grant = {
      runId: input.runId,
      stepKey: input.stepKey,
      depth: input.depth,
      tools: new Set(input.tools),
      record: previous?.record ?? this.closed.get(input.stepKey) ?? emptyRecord(),
      sessions: new Set(),
      controller: new AbortController(),
    }
    this.grants.set(input.stepKey, grant)
    return () => {
      if (this.grants.get(input.stepKey) === grant) this.drop(grant)
    }
  }

  /** Records of closed grants, kept until read by `take`. */
  private readonly closed = new Map<string, GrantRecord>()

  /** What the step's tool calls collected (empty when nothing was granted in this process). */
  collected(stepKey: string): GrantRecord {
    return this.grants.get(stepKey)?.record ?? this.closed.get(stepKey) ?? emptyRecord()
  }

  /** Reads and forgets a closed grant's record. */
  take(stepKey: string): GrantRecord {
    const out = this.collected(stepKey)
    this.closed.delete(stepKey)
    return out
  }

  private drop(grant: Grant) {
    grant.controller.abort(new Error('the research step ended'))
    this.grants.delete(grant.stepKey)
    for (const id of grant.sessions) this.bySession.delete(id)
    this.closed.set(grant.stepKey, grant.record)
  }

  close() {
    for (const grant of [...this.grants.values()]) this.drop(grant)
    void this.server?.stop(true)
    this.server = null
  }

  private grantOf(sessionId: string): Grant | null {
    const known = this.bySession.get(sessionId)
    if (known && this.grants.get(known.stepKey) === known) return known
    for (const grant of this.grants.values()) {
      if (!(this.options.belongsTo ?? isStepSession)(sessionId, grant.stepKey)) continue
      grant.sessions.add(sessionId)
      this.bySession.set(sessionId, grant)
      return grant
    }
    return null
  }

  private authorized(header: string | null): boolean {
    const given = /^Bearer +(\S+)$/i.exec(header ?? '')?.[1] ?? ''
    const digest = (text: string) => createHash('sha256').update(text).digest()
    return timingSafeEqual(digest(given), digest(this.key))
  }

  /** The HTTP door: `POST /tool/<name>` with `{sessionID, args}`; answers `{ok, result}` or `{ok: false, error}`. */
  async handle(req: Request): Promise<Response> {
    const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status })
    if (!this.authorized(req.headers.get('authorization'))) return answer(401, { ok: false, error: 'unauthorized' })
    const name = /^\/tool\/([a-z_]+)$/.exec(new URL(req.url).pathname)?.[1]
    if (req.method !== 'POST' || !name) return answer(404, { ok: false, error: 'not found' })
    if (!(GATE_TOOLS as readonly string[]).includes(name)) return answer(404, { ok: false, error: `no tool ${name}` })
    const tool = name as GateTool
    const raw = await req.text()
    if (raw.length > MAX_BODY) return answer(413, { ok: false, error: 'request too large' })
    let call: z.output<typeof ToolCall>
    try {
      call = ToolCall.parse(JSON.parse(raw))
    } catch {
      return answer(400, { ok: false, error: 'expected {sessionID, args}' })
    }
    const grant = this.grantOf(call.sessionID)
    if (!grant) return answer(403, { ok: false, error: 'this session holds no research grant' })
    if (!grant.tools.has(tool)) return answer(403, { ok: false, error: `${tool} is not granted to this agent` })
    try {
      const result = await this.run(grant, tool, call.args)
      return answer(200, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      grant.record.entries.push({ tool, ok: false, retrieved: [], seen: [], error: message.slice(0, 300) })
      return answer(200, { ok: false, error: message.slice(0, 1_000) })
    }
  }

  private async run(grant: Grant, tool: GateTool, args: Record<string, Json>): Promise<Json> {
    const signal = grant.controller.signal
    const addUsage = (usage: Usage) => grant.record.usage.push(usage)
    if (tool === 'engine_research') return this.engineResearch(grant, args)
    const output = await this.options.call(CAPABILITY[tool], args, { addUsage, signal })
    const out = record(output)
    const entry: LedgerEntry = { tool, ok: true, retrieved: [], seen: [] }
    if (tool === 'web_search') {
      entry.seen = (Array.isArray(out.results) ? out.results : []).flatMap((r) => {
        const url = record(r).url
        return typeof url === 'string' ? [url] : []
      })
    } else if (tool === 'web_fetch') {
      entry.retrieved = [args.url, out.url, out.finalUrl].filter((u): u is string => typeof u === 'string')
    } else if (tool === 'web_package' && typeof out.url === 'string') {
      entry.retrieved = [out.url]
    } else if (tool === 'web_docs' && typeof out.source === 'string' && /^https?:/.test(out.source)) {
      entry.retrieved = [out.source]
    }
    grant.record.entries.push(entry)
    return output
  }

  /** One quick engine job per question; the engine's sources are pages it retrieved, so they count as retrieved here. */
  private async engineResearch(grant: Grant, args: Record<string, Json>): Promise<Json> {
    const engine = this.options.engine()
    if (!engine) throw new Error('no research engine is configured')
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (question.length < 3) throw new Error('engine_research needs a question')
    const digest = createHash('sha256').update(question).digest('hex').slice(0, 16)
    const { jobId, report } = await runEngineJob(
      engine,
      { query: question, depth: 'quick', idempotencyKey: `${grant.stepKey}:engine:${digest}` },
      { signal: grant.controller.signal, ...(this.options.enginePollMs ? { pollMs: this.options.enginePollMs } : {}) },
    )
    const cost = report.cost?.totalUsd
    grant.record.engineJobs.push(jobId)
    grant.record.usage.push({
      model: 'research-gateway',
      tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      cost: typeof cost === 'number' ? cost : null,
      costSource: typeof cost === 'number' ? 'provider' : 'unknown',
    })
    if (typeof cost === 'number') grant.record.engineCostUsd = (grant.record.engineCostUsd ?? 0) + cost
    grant.record.entries.push({
      tool: 'engine_research',
      ok: true,
      retrieved: [...report.sources, ...report.citations.map((c) => c.url)],
      seen: [],
    })
    return {
      report: report.report,
      citations: report.citations,
      sources: report.sources,
      unverified: report.unverified,
      status: report.status,
    }
  }
}

/** The URLs a grant's tool calls retrieved and saw, normalized. */
export function evidence(rec: GrantRecord): { retrieved: Set<string>; seen: Set<string>; failed: number } {
  const retrieved = new Set<string>()
  const seen = new Set<string>()
  let failed = 0
  for (const entry of rec.entries) {
    for (const url of entry.retrieved) retrieved.add(normalizeUrl(url))
    for (const url of entry.seen) seen.add(normalizeUrl(url))
    if (!entry.ok && entry.tool === 'web_fetch') failed++
  }
  return { retrieved, seen, failed }
}

/** Tool calls per tool, failures included. */
export function toolCounts(rec: GrantRecord): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of rec.entries) counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
  return counts
}
