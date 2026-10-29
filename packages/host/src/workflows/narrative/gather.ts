import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The bounded, deterministic gathering of `narrative` (agent-gateway `server/jobs/handlers/narrative.ts`): the commits
// and the session-transcript prose since the cutoff. The bounds are legacy's, verbatim. Both readers are ports, so a
// test drives the gathering with a fake git and a fake transcript directory.

export const BOOTSTRAP_DAYS = 180
export const BOOTSTRAP_COMMIT_LIMIT = 120
export const BOOTSTRAP_SESSION_LIMIT = 12
/** The newest transcripts read for a real cutoff: a project with hundreds of files since the cutoff does not read them all. */
export const SINCE_SESSION_LIMIT = 24
export const MIN_SESSION_FILE_BYTES = 4 * 1024
/** Never read a whole transcript (they reach 16 MB): only this tail. */
export const SESSION_TAIL_BYTES = 1024 * 1024
export const SESSIONS_MAX_BYTES = 40 * 1024
export const COMMITS_MAX_BYTES = 30 * 1024
export const MIN_PROSE_BLOCK_CHARS = 200
export const MAX_PROSE_BLOCKS_PER_SESSION = 3

export interface SessionFile {
  file: string
  size: number
  mtimeMs: number
}

export interface GatherPorts {
  /** `git -C <cwd> <args>` stdout; "" when git fails (a missing repo gathers no commits). */
  git(cwd: string, args: string[]): Promise<string>
  /** The `*.jsonl` files of a project's transcript directory, with size and mtime; [] when it does not exist. */
  sessionFiles(dir: string): Promise<SessionFile[]>
  /** The last `maxBytes` of a file, starting at a line boundary; throws when unreadable. */
  readTail(path: string, maxBytes: number): Promise<string>
  /** The transcripts' root (`~/.claude/projects`). */
  projectsDir: string
}

export function defaultGatherPorts(): GatherPorts {
  return {
    async git(cwd, args) {
      try {
        const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
      } catch {
        return ''
      }
    },
    async sessionFiles(dir) {
      let files: string[]
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        return []
      }
      const stats = await Promise.all(
        files.map(async (file): Promise<SessionFile | null> => {
          try {
            const st = await stat(join(dir, file))
            return { file, size: st.size, mtimeMs: st.mtimeMs }
          } catch {
            return null
          }
        }),
      )
      return stats.filter((s): s is SessionFile => s !== null)
    },
    async readTail(path, maxBytes) {
      const file = Bun.file(path)
      const size = file.size
      const start = Math.max(0, size - maxBytes)
      const raw = await file.slice(start, size).text()
      const firstNewline = raw.indexOf('\n')
      return start > 0 && firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw
    },
    projectsDir: join(homedir(), '.claude', 'projects'),
  }
}

/** The directory name Claude Code gives a project's transcripts: every character that is not `[A-Za-z0-9]` becomes `-`. */
export const encodeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

// ── Transcript prose ────────────────────────────────────────────────────────────────────────

export interface SessionProse {
  aiTitle: string | null
  /** The last (most recent) `MAX_PROSE_BLOCKS_PER_SESSION` assistant text blocks of at least 200 chars, chronologically. */
  blocks: string[]
}

/**
 * Parses a (possibly tail-truncated) transcript `.jsonl` slice, pulling only `ai-title` lines and long assistant text
 * blocks: never tool_use or tool_result content, and never user lines (where tool_result blocks actually live).
 */
export function extractSessionProse(text: string): SessionProse {
  let aiTitle: string | null = null
  const blocks: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      aiTitle = record.aiTitle
      continue
    }
    if (record.type !== 'assistant') continue
    const content = (record.message as Record<string, unknown> | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      const trimmedText = b.text.trim()
      if (trimmedText.length >= MIN_PROSE_BLOCK_CHARS) blocks.push(trimmedText)
    }
  }
  return { aiTitle, blocks: blocks.slice(-MAX_PROSE_BLOCKS_PER_SESSION) }
}

// ── Gathering ───────────────────────────────────────────────────────────────────────────────

const COMMIT_SEP = '\x1e'
const bytesOf = (text: string) => Buffer.byteLength(text, 'utf-8')

export type Gathered = {
  commits: { text: string; count: number }
  sessions: { text: string; count: number }
  /** The effective ISO cutoff: `since`, else the bootstrap floor. */
  sinceUsed: string
}

/**
 * `git log`, newest first, cut at the 30 KB cap (the oldest are dropped). Bootstrap intersects a commit-count limit with a
 * day-count `--since` (git applies both as AND), which is exactly "whichever is smaller".
 */
async function gatherCommits(
  ports: GatherPorts,
  cwd: string,
  since: string | null,
  bootstrapSince: string,
): Promise<Gathered['commits']> {
  const args = [
    'log',
    '--no-merges',
    `--pretty=format:%h %cI %s%n%b${COMMIT_SEP}`,
    `--since=${since ?? bootstrapSince}`,
  ]
  if (!since) args.push('-n', String(BOOTSTRAP_COMMIT_LIMIT))
  const entries = (await ports.git(cwd, args))
    .split(COMMIT_SEP)
    .map((e) => e.trim())
    .filter(Boolean)
  const used: string[] = []
  let bytes = 0
  for (const entry of entries) {
    const size = bytesOf(entry) + 2
    if (bytes + size > COMMITS_MAX_BYTES) break
    used.push(entry)
    bytes += size
  }
  return { text: used.join('\n\n'), count: used.length }
}

/**
 * Transcripts under `<projects>/<encodeProjectDir(cwd)>/*.jsonl`, newest first, 40 KB total cap. Bootstrap (no `since`)
 * takes the newest 12 files with no date filter; a real `since` filters by mtime instead and reads the newest 24 of them. Files under 4 KB are skipped
 * outright, and a file that yields no title and no long assistant block is dropped without consuming any budget.
 */
async function gatherSessions(ports: GatherPorts, cwd: string, since: string | null): Promise<Gathered['sessions']> {
  const dir = join(ports.projectsDir, encodeProjectDir(cwd))
  const sinceMs = since ? Date.parse(since) : null
  let candidates = (await ports.sessionFiles(dir)).filter((s) => s.size >= MIN_SESSION_FILE_BYTES)
  if (sinceMs !== null) candidates = candidates.filter((s) => s.mtimeMs > sinceMs)
  candidates = candidates.toSorted((a, b) => b.mtimeMs - a.mtimeMs)
  candidates = candidates.slice(0, sinceMs === null ? BOOTSTRAP_SESSION_LIMIT : SINCE_SESSION_LIMIT)

  const entries: string[] = []
  let bytes = 0
  for (const c of candidates) {
    // Fail soft, as a transcript the user is writing to right now may vanish or tear: an unreadable tail is an empty one.
    const prose = await ports
      .readTail(join(dir, c.file), SESSION_TAIL_BYTES)
      .then(extractSessionProse, (): SessionProse => ({ aiTitle: null, blocks: [] }))
    if (!prose.aiTitle && prose.blocks.length === 0) continue
    const lines = [`## Session ${c.file.replace(/\.jsonl$/, '')} (${new Date(c.mtimeMs).toISOString()})`]
    if (prose.aiTitle) lines.push(`ai-title: ${prose.aiTitle}`)
    lines.push(...prose.blocks.map((b) => `- ${b}`))
    const entryText = lines.join('\n')
    const size = bytesOf(entryText) + 2
    if (bytes + size > SESSIONS_MAX_BYTES) break
    entries.push(entryText)
    bytes += size
  }
  return { text: entries.join('\n\n'), count: entries.length }
}

export async function gatherFacts(
  ports: GatherPorts,
  args: { cwd: string; since: string | null; now: number },
): Promise<Gathered> {
  const bootstrapSince = new Date(args.now - BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [commits, sessions] = await Promise.all([
    gatherCommits(ports, args.cwd, args.since, bootstrapSince),
    gatherSessions(ports, args.cwd, args.since),
  ])
  return { commits, sessions, sinceUsed: args.since ?? bootstrapSince }
}
