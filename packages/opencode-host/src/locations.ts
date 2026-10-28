import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { RouteId } from '@agent-workflows/routes'
import type { Json } from '@agent-workflows/runtime'

/** An agent as the host serves it: compiled into its own location directory, outside every repo. */
export type AgentDefinition = {
  name: string
  agentsMd: string
  /** Files under the location's `.opencode/skills/`, keyed by relative path (`review/SKILL.md`). */
  skills?: Record<string, string>
  /** Written as the location's `opencode.json` (agent permissions, instructions). */
  config?: Json
  /** The default route of the agent's sessions; `options.route` on the step overrides it. */
  route?: RouteId
}

export type CompiledLocation = { name: string; directory: string; hash: string; changed: boolean }

export const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'agent-workflows')
const MARKER = '.agw-location.json'
const NAME = /^[a-z0-9][a-z0-9._-]*$/
/** Files that make an ancestor leak into a location: instructions OpenCode walks up to, or a repo root. */
const LEAKS = ['AGENTS.md', 'CLAUDE.md', '.git']

export class LocationLeakError extends Error {
  override name = 'LocationLeakError'
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** sha256 over everything the location holds; an input of the run fingerprint (concept §5). */
export function locationHash(def: AgentDefinition): string {
  const content = { v: 1, agentsMd: def.agentsMd, skills: def.skills ?? {}, config: def.config ?? null }
  return createHash('sha256').update(canonical(content)).digest('hex')
}

/** Throws when any ancestor of `directory` holds an `AGENTS.md`, a `CLAUDE.md` or a `.git` (concept §8). */
export function assertNoAncestorLeak(directory: string): void {
  let dir = dirname(resolve(directory))
  for (;;) {
    for (const leak of LEAKS) {
      const path = join(dir, leak)
      if (existsSync(path)) throw new LocationLeakError(`${path} is an ancestor of location ${directory}`)
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

function skillPath(root: string, key: string): string {
  const rel = normalize(key)
  if (isAbsolute(rel) || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`skill path "${key}" leaves the skills directory`)
  }
  return join(root, '.opencode', 'skills', rel)
}

/**
 * Writes an agent into `<stateDir>/locations/<name>/`. Idempotent: an unchanged hash writes nothing. A change
 * replaces the directory atomically (build beside it, rename over), so a reader never sees half a location.
 */
export function compileLocation(def: AgentDefinition, options: { stateDir?: string } = {}): CompiledLocation {
  if (!NAME.test(def.name)) throw new Error(`agent name "${def.name}" is not a valid location name`)
  const root = join(options.stateDir ?? DEFAULT_STATE_DIR, 'locations')
  const directory = join(root, def.name)
  mkdirSync(root, { recursive: true })
  assertNoAncestorLeak(directory)
  const hash = locationHash(def)
  if (readMarker(directory) === hash) return { name: def.name, directory, hash, changed: false }

  const tmp = `${directory}.tmp-${randomUUID()}`
  try {
    mkdirSync(tmp, { recursive: true })
    writeFileSync(join(tmp, 'AGENTS.md'), def.agentsMd)
    for (const [key, text] of Object.entries(def.skills ?? {})) {
      const path = skillPath(tmp, key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    if (def.config !== undefined) writeFileSync(join(tmp, 'opencode.json'), `${JSON.stringify(def.config, null, 2)}\n`)
    writeFileSync(join(tmp, MARKER), `${JSON.stringify({ name: def.name, hash })}\n`)
    const old = `${directory}.old-${randomUUID()}`
    if (existsSync(directory)) renameSync(directory, old)
    renameSync(tmp, directory)
    rmSync(old, { recursive: true, force: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { name: def.name, directory, hash, changed: true }
}

function readMarker(directory: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(directory, MARKER), 'utf8')) as { hash?: string }).hash ?? null
  } catch {
    return null
  }
}

export type WarmCacheOptions = {
  /** Evict a location nobody used for this long. Default 10 minutes. */
  evictAfterMs?: number
  /** At most this many warm locations; the least recently used idle one goes first. Default 16. */
  maxWarm?: number
  now?: () => number
}

type Entry = { lastUsed: number; inUse: number; stale: boolean }

/**
 * Which locations the server has booted, and when to dispose them. A location in use (an open handle waiting on
 * it) is never evicted: eviction rebuilds its services, and a running session would pick up a changed head
 * (AGENTS.md, skills) at its next step. A changed location is marked stale and evicted once it is idle.
 */
export class WarmCache {
  private readonly entries = new Map<string, Entry>()
  private readonly evictAfterMs: number
  private readonly maxWarm: number
  private readonly now: () => number

  constructor(
    private readonly port: { warm(directory: string): Promise<void>; evict(directory: string): Promise<void> },
    options: WarmCacheOptions = {},
  ) {
    this.evictAfterMs = options.evictAfterMs ?? 10 * 60_000
    this.maxWarm = options.maxWarm ?? 16
    this.now = options.now ?? Date.now
  }

  /** Marks the location in use (warming it on first use); call the returned release when done. */
  async use(directory: string, options: { changed?: boolean } = {}): Promise<() => void> {
    let entry = this.entries.get(directory)
    if (entry && options.changed) entry.stale = true
    if (entry?.stale && entry.inUse === 0) {
      await this.port.evict(directory)
      this.entries.delete(directory)
      entry = undefined
    }
    if (!entry) {
      await this.port.warm(directory)
      entry = { lastUsed: this.now(), inUse: 0, stale: false }
      this.entries.set(directory, entry)
    }
    entry.inUse++
    entry.lastUsed = this.now()
    const used = entry
    let released = false
    await this.shrink()
    return () => {
      if (released) return
      released = true
      used.inUse--
      used.lastUsed = this.now()
    }
  }

  warm(): string[] {
    return [...this.entries.keys()]
  }

  /** The server restarted: it holds no location any more. Handles still in use keep their counts. */
  reset(): void {
    for (const [directory, entry] of this.entries) if (entry.inUse === 0) this.entries.delete(directory)
  }

  /** Evicts idle locations past `evictAfterMs`, stale ones, and the least recently used beyond `maxWarm`. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const [directory, entry] of [...this.entries]) {
      if (entry.inUse > 0) continue
      if (entry.stale || now - entry.lastUsed >= this.evictAfterMs) await this.evict(directory)
    }
    await this.shrink()
  }

  private async shrink(): Promise<void> {
    const idle = [...this.entries].filter(([, e]) => e.inUse === 0).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    while (this.entries.size > this.maxWarm && idle.length > 0) {
      const [directory] = idle.shift() as [string, Entry]
      await this.evict(directory)
    }
  }

  private async evict(directory: string): Promise<void> {
    await this.port.evict(directory)
    this.entries.delete(directory)
  }
}
