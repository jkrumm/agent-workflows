import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { RouteId } from '@agent-workflows/routes'
import type { Json, Logger } from '@agent-workflows/runtime'
import type { PermissionRule } from './client.ts'

/** An agent as the host serves it: compiled into its own location directory, outside every repo. */
export type AgentDefinition = {
  name: string
  agentsMd: string
  /** Files under the location's `.opencode/skills/`, keyed by relative path (`review/SKILL.md`). */
  skills?: Record<string, string>
  /** Written as the location's `opencode.json` (instructions, formatter, …). */
  config?: Json
  /** The default route of the agent's sessions; `options.route` on the step overrides it. */
  route?: RouteId
  /**
   * Tool permissions of the agent's sessions. The shell tool is denied unless `shell: true`; `rules` are appended
   * after the host's own (the last matching rule wins). Never use `ask`: an unattended session would block on it.
   */
  permissions?: { shell?: boolean; rules?: PermissionRule[] }
}

export type CompiledLocation = { name: string; directory: string; hash: string; changed: boolean }

export const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'agent-workflows')
const MARKER = '.agw-location.json'
const NAME = /^[a-z0-9][a-z0-9._-]*$/
const HASH_DIR = /^[0-9a-f]{16}$/
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

/** sha256 over everything that shapes the agent's sessions; an input of the run fingerprint (concept §5). */
export function locationHash(def: AgentDefinition): string {
  const content = {
    v: 2,
    agentsMd: def.agentsMd,
    skills: def.skills ?? {},
    config: def.config ?? null,
    permissions: def.permissions ?? null,
  }
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
  if (isAbsolute(rel) || rel.split(sep).includes('..'))
    throw new Error(`skill path "${key}" leaves the skills directory`)
  return join(root, '.opencode', 'skills', rel)
}

/**
 * Writes an agent into `<stateDir>/locations/<name>/<hash>/`, a directory per content hash that never changes once
 * written: a session runs in the hash directory it was opened in, so a changed agent never touches a running
 * session's files. Idempotent: an existing hash directory is reused (`changed: false`). A new one is built beside
 * it and renamed into place, so a reader never sees half a location.
 */
export function compileLocation(def: AgentDefinition, options: { stateDir?: string } = {}): CompiledLocation {
  if (!NAME.test(def.name)) throw new Error(`agent name "${def.name}" is not a valid location name`)
  const parent = join(options.stateDir ?? DEFAULT_STATE_DIR, 'locations', def.name)
  const hash = locationHash(def)
  const directory = join(parent, hash.slice(0, 16))
  mkdirSync(parent, { recursive: true })
  assertNoAncestorLeak(directory)
  if (existsSync(join(directory, MARKER))) return { name: def.name, directory, hash, changed: false }

  const tmp = join(parent, `.tmp-${randomUUID()}`)
  try {
    mkdirSync(tmp)
    writeFileSync(join(tmp, 'AGENTS.md'), def.agentsMd)
    for (const [key, text] of Object.entries(def.skills ?? {})) {
      const path = skillPath(tmp, key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    if (def.config !== undefined) writeFileSync(join(tmp, 'opencode.json'), `${JSON.stringify(def.config, null, 2)}\n`)
    writeFileSync(join(tmp, MARKER), `${JSON.stringify({ name: def.name, hash })}\n`)
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true }) // a crashed earlier build
    renameSync(tmp, directory)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { name: def.name, directory, hash, changed: true }
}

/** Records a use (the marker's mtime), so pruning keeps a hash directory a session used recently. */
export function touchLocation(directory: string, at = new Date()): void {
  try {
    utimesSync(join(directory, MARKER), at, at)
  } catch {
    // pruned or never compiled: the next open compiles it again
  }
}

/**
 * Removes hash directories that are not in `keep` (the current hashes, warm locations and the directories of
 * sessions the server runs) and were not used for `retentionMs`. The retention covers sessions that are neither
 * warm nor running yet will be re-attached (a run resumed after a crash). Returns the removed directories.
 */
export function pruneLocations(options: {
  stateDir?: string
  keep: ReadonlySet<string>
  retentionMs: number
  now?: number
}): string[] {
  const root = join(options.stateDir ?? DEFAULT_STATE_DIR, 'locations')
  const now = options.now ?? Date.now()
  const removed: string[] = []
  if (!existsSync(root)) return removed
  for (const name of readdirSync(root)) {
    const parent = join(root, name)
    for (const entry of readdirSync(parent)) {
      const directory = join(parent, entry)
      if (!HASH_DIR.test(entry) || options.keep.has(directory)) continue
      let used: number
      try {
        used = statSync(join(directory, MARKER)).mtimeMs
      } catch {
        continue
      }
      if (now - used < options.retentionMs) continue
      rmSync(directory, { recursive: true, force: true })
      removed.push(directory)
    }
  }
  return removed
}

/**
 * Removes leftovers of crashed writes older than `maxAgeMs` (10 min): `locations/<name>/.tmp-*` build directories
 * and `opencode/server.json.tmp-*`. A write in flight is younger than that by far. Returns what was removed.
 */
export function sweepStaleTemps(options: { stateDir?: string; maxAgeMs?: number; now?: number } = {}): string[] {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? 10 * 60_000)
  const candidates: string[] = []
  const locations = join(stateDir, 'locations')
  if (existsSync(locations)) {
    for (const name of readdirSync(locations)) {
      const parent = join(locations, name)
      for (const entry of readdirSync(parent)) if (entry.startsWith('.tmp-')) candidates.push(join(parent, entry))
    }
  }
  const server = join(stateDir, 'opencode')
  if (existsSync(server)) {
    for (const entry of readdirSync(server))
      if (entry.startsWith('server.json.tmp-')) candidates.push(join(server, entry))
  }
  const removed: string[] = []
  for (const path of candidates) {
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (mtime >= cutoff) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
}

export type WarmCacheOptions = {
  /** Evict a location nobody used for this long. Default 10 minutes. */
  evictAfterMs?: number
  /** At most this many warm locations; the least recently used idle one goes first. Default 16. */
  maxWarm?: number
  now?: () => number
  logger?: Logger
}

type Entry = {
  /** `cold`: known, but the server holds nothing (after a restart); the next use warms it. */
  state: 'warming' | 'warm' | 'evicting' | 'cold'
  inUse: number
  lastUsed: number
  stale: boolean
  /** Settles when the current warm or evict finishes. */
  settled: Promise<void>
}

const silent: Logger = { warn: () => {}, error: () => {} }

/**
 * Which locations the server has booted, and when to dispose them. Single-flight per directory: concurrent first
 * uses share one warm and one refcounted entry. A location in use is never evicted (an eviction rebuilds its
 * services and a running session would pick up a changed head at its next step). Evict failures are logged and
 * retried on the next tick; they never fail a use.
 */
export class WarmCache {
  private readonly entries = new Map<string, Entry>()
  private readonly evictAfterMs: number
  private readonly maxWarm: number
  private readonly now: () => number
  private readonly logger: Logger

  constructor(
    private readonly port: { warm(directory: string): Promise<void>; evict(directory: string): Promise<void> },
    options: WarmCacheOptions = {},
  ) {
    this.evictAfterMs = options.evictAfterMs ?? 10 * 60_000
    this.maxWarm = options.maxWarm ?? 16
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? silent
  }

  /**
   * Marks the location in use, warming it first when needed; call the returned release when done. `changed`
   * means its content is new to this process: a warm entry is marked stale (evicted once idle), and with no entry
   * the server is told to dispose it before the warm, since an adopted server may hold an older head.
   */
  async use(directory: string, options: { changed?: boolean } = {}): Promise<() => void> {
    let triedEvict = false
    for (;;) {
      let entry = this.entries.get(directory)
      if (entry?.state === 'evicting') {
        await entry.settled
        continue
      }
      if (entry && options.changed) entry.stale = true
      if (entry?.stale && entry.inUse === 0 && entry.state === 'warm' && !triedEvict) {
        triedEvict = true // a failed evict is logged; this use goes on with the old head, the tick retries
        await this.evict(directory, entry)
        continue
      }
      if (!entry) {
        entry = { state: 'warming', inUse: 0, lastUsed: this.now(), stale: false, settled: Promise.resolve() }
        this.entries.set(directory, entry)
        this.warm(directory, entry, options.changed === true && !triedEvict)
      } else if (entry.state === 'cold') {
        entry.state = 'warming'
        entry.stale = false
        this.warm(directory, entry, false)
      }
      entry.inUse++
      try {
        await entry.settled
        if (entry.state !== 'warm') throw new Error(`location ${directory} failed to warm`)
      } catch (err) {
        entry.inUse--
        throw err
      }
      entry.lastUsed = this.now()
      await this.shrink()
      return this.releaser(entry)
    }
  }

  /** Locations the server holds warm. */
  warmLocations(): string[] {
    return [...this.entries].filter(([, e]) => e.state === 'warm').map(([d]) => d)
  }

  /** Every directory the cache knows (warm, warming, in use): pruning keeps them. */
  known(): Set<string> {
    return new Set(this.entries.keys())
  }

  /** The server restarted and holds no location: every entry goes cold, counts stay, the next use warms. */
  reset(): void {
    for (const entry of this.entries.values()) if (entry.state !== 'warming') entry.state = 'cold'
  }

  /** Evicts idle locations past `evictAfterMs`, stale ones, and the least recently used beyond `maxWarm`. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const [directory, entry] of [...this.entries]) {
      if (this.entries.get(directory) !== entry || entry.inUse > 0) continue
      if (entry.state === 'cold') {
        this.entries.delete(directory)
        continue
      }
      // Checked right before the evict, with no await between: the snapshot above may be stale.
      if (this.evictable(directory, entry) && (entry.stale || now - entry.lastUsed >= this.evictAfterMs)) {
        await this.evict(directory, entry)
      }
    }
    await this.shrink()
  }

  private warm(directory: string, entry: Entry, disposeFirst: boolean): void {
    entry.settled = (async () => {
      try {
        if (disposeFirst) await this.port.evict(directory)
        await this.port.warm(directory)
        entry.state = 'warm'
      } catch (err) {
        if (this.entries.get(directory) === entry) this.entries.delete(directory)
        entry.state = 'cold'
        throw err
      }
    })()
    entry.settled.catch(() => {}) // observed by every use() awaiting it
  }

  private releaser(entry: Entry): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.inUse--
      entry.lastUsed = this.now()
    }
  }

  private async shrink(): Promise<void> {
    const idle = [...this.entries]
      .filter(([, e]) => e.inUse === 0 && e.state === 'warm')
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    for (const [directory, entry] of idle) {
      if (this.warmLocations().length <= this.maxWarm) return
      // Re-checked after every await: a use() during an earlier DELETE makes this entry busy again.
      if (!this.evictable(directory, entry)) continue
      await this.evict(directory, entry)
    }
  }

  private evictable(directory: string, entry: Entry): boolean {
    return this.entries.get(directory) === entry && entry.inUse === 0 && entry.state === 'warm'
  }

  /** Never throws: a failed DELETE is logged and the entry stays warm, retried on the next tick. */
  private async evict(directory: string, entry: Entry): Promise<boolean> {
    entry.state = 'evicting'
    let ok = false
    entry.settled = (async () => {
      try {
        await this.port.evict(directory)
        ok = true
      } catch (err) {
        this.logger.warn('opencode location eviction failed; retried next tick', {
          directory,
          error: (err as Error).name,
        })
      }
      if (!ok) entry.state = 'warm'
      else if (entry.inUse > 0) entry.state = 'cold'
      else if (this.entries.get(directory) === entry) this.entries.delete(directory)
    })()
    await entry.settled
    return ok
  }
}
