import { existsSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { helperEnv, networkEnv } from '../workflows/review/exec.ts'
import {
  type ClaudeAgentRaw,
  cleanLine,
  EMPTY_TAIL,
  encodeProjectDir,
  type HerdrAgentRaw,
  type HerdrWorkspaceRaw,
  mergeAgents,
  parseTranscriptTail,
  type TranscriptTail,
} from './derive.ts'
import type { HumanQueueEntry, ProjectGit, Snapshot, Summary } from './schema.ts'
import { oneLine, stripControlBytes } from './text.ts'

// The impure half of the snapshot: herdr and Claude's registry, transcript tails, the human queue, session accounts
// and git status. Every one is a port, so tests run the whole builder on fakes.

const CLI_TIMEOUT_MS = 5_000
const TAIL_BYTES = 512 * 1024
const MAX_TAIL_BYTES = 8 * 1024 * 1024
const GIT_FETCH_TIMEOUT_MS = 5_000
const DEFAULT_STALE_HOURS = 24

export interface CollectorResult<T> {
  items: T[]
  warning: string | null
}

/**
 * Runs a command and answers its stdout; `null` on a spawn error, a timeout or a non-zero exit. `network` is for the one
 * call that talks to a remote (`git fetch`): it adds the credential and proxy variables to the child's environment.
 */
export type RunCommand = (cmd: string[], options?: { timeoutMs?: number; network?: boolean }) => Promise<string | null>

/**
 * The command runner on `env`. A child (git, herdr, claude) gets the review helpers' allowlist (`helperEnv`: no
 * credential prompts, no optional git locks) and, for a `network` call, the SSH agent, config directory and proxy/CA
 * settings (`networkEnv`); never `AGW_API_SECRET`, `ARGO_API_SECRET` or `IU_API_KEY`.
 */
export function commandRunner(env: Record<string, string | undefined> = process.env): RunCommand {
  const local = helperEnv(env)
  const remote = { ...local, ...networkEnv(env) }
  return async (cmd, options = {}) => {
    try {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', env: options.network ? remote : local })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGKILL')
      }, options.timeoutMs ?? CLI_TIMEOUT_MS)
      try {
        const text = await new Response(proc.stdout).text()
        const code = await proc.exited
        return timedOut || code !== 0 ? null : text
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }
}

export const runCommand: RunCommand = commandRunner()

export interface FleetConfig {
  herdrBin: string
  claudeBin: string
  /** `<state>/human-queue`: `<id>.req` is a pending request, `<id>.res` its answer. */
  humanQueueDir: string
  /** `~/.claude/projects`: `<encoded cwd>/<sessionId>.jsonl`. */
  claudeProjectsDir: string
  /** `~/.claude/logs`: day files carrying the `session_env` lines. */
  claudeLogDir: string
  staleAfterHours: number
}

type Env = Record<string, string | undefined>

/** Settings from the host's environment: every path has a default under the user's home, every one a name to override it. */
export function fleetConfig(env: Env, home = homedir()): FleetConfig {
  const bin = (name: string, override: string | undefined) => {
    if (override?.trim()) return override.trim()
    const local = join(home, '.local', 'bin', name)
    return existsSync(local) ? local : name
  }
  const hours = Number.parseInt(env.AGW_AGENT_STALE_HOURS ?? '', 10)
  return {
    herdrBin: bin('herdr', env.AGW_HERDR_BIN),
    claudeBin: bin('claude', env.AGW_CLAUDE_BIN),
    humanQueueDir: join(env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state'), 'human-queue'),
    claudeProjectsDir: join(home, '.claude', 'projects'),
    claudeLogDir: env.AGW_CLAUDE_LOG_DIR?.trim() || join(home, '.claude', 'logs'),
    staleAfterHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_STALE_HOURS,
  }
}

/** One pending `.req` body as a queue entry, or null when it is not the expected shape. */
export function parseHumanQueueRequest(text: string, fallbackId: string): HumanQueueEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string') return null
  // A request is written by an agent and lands in a coloured pane and in a chat: a stray ESC must reach neither.
  const cmd = typeof r.cmd === 'string' ? stripControlBytes(r.cmd) : ''
  return {
    id: (typeof r.id === 'string' && oneLine(r.id)) || oneLine(fallbackId),
    askedAt: typeof r.created === 'string' ? oneLine(r.created) || null : null,
    question: stripControlBytes(r.text),
    cmd: cmd || null,
  }
}

/** A queue is a handful of requests: the newest this many are read, none larger than {@link MAX_REQUEST_BYTES}. */
const MAX_QUEUE_FILES = 200
const MAX_REQUEST_BYTES = 64 * 1024

/** Pending requests in `dir`, newest first (ids sort chronologically). A missing directory is an empty queue, never a warning. */
export async function readHumanQueue(dir: string): Promise<CollectorResult<HumanQueueEntry>> {
  let names: Set<string>
  try {
    names = new Set(await readdir(dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], warning: null }
    return { items: [], warning: `human-queue read failed: ${String(error)}` }
  }
  const pending = [...names]
    .filter((name) => name.endsWith('.req') && !name.startsWith('.') && !names.has(`${name.slice(0, -4)}.res`))
    .toSorted()
    .toReversed()
  const items: HumanQueueEntry[] = []
  let skipped = 0
  for (const name of pending.slice(0, MAX_QUEUE_FILES)) {
    try {
      const path = join(dir, name)
      const info = await lstat(path)
      if (!info.isFile() || info.size > MAX_REQUEST_BYTES) {
        skipped += 1
        continue
      }
      const entry = parseHumanQueueRequest(await Bun.file(path).text(), name.slice(0, -'.req'.length))
      if (entry) items.push(entry)
    } catch {
      skipped += 1 // answered or removed while reading
    }
  }
  items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const dropped = skipped + Math.max(0, pending.length - MAX_QUEUE_FILES)
  return {
    items,
    warning: dropped > 0 ? `human-queue: ${dropped} request(s) skipped (unreadable, oversized or over the cap)` : null,
  }
}

/** What a `pick` answers: the rows that passed the shape check, and how many did not. */
interface Picked<T> {
  items: T[]
  dropped: number
}

async function readJsonCommand<T>(
  run: RunCommand,
  cmd: string[],
  label: string,
  pick: (parsed: unknown) => Picked<T>,
): Promise<CollectorResult<T>> {
  const out = await run(cmd)
  if (out == null) return { items: [], warning: `${label} failed or timed out` }
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return { items: [], warning: `${label} returned unparseable JSON` }
  }
  try {
    const { items, dropped } = pick(parsed)
    return { items, warning: dropped > 0 ? `${label}: ${dropped} malformed row(s) dropped` : null }
  } catch {
    return { items: [], warning: `${label} returned an unexpected shape` }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every named field is absent, null or of `type`. */
const typed = (row: Record<string, unknown>, type: 'string' | 'number', ...keys: string[]) =>
  keys.every((key) => row[key] == null || typeof row[key] === type)

/** The rows of `list` that `valid` accepts, narrowed; a null, a scalar or a wrong-typed row is counted, never thrown on. */
function pickRows<T>(list: unknown, valid: (row: Record<string, unknown>) => boolean): Picked<T> {
  if (!Array.isArray(list)) throw new Error('not a list')
  const items = list.filter((row): row is Record<string, unknown> => isRecord(row) && valid(row)) as unknown as T[]
  return { items, dropped: list.length - items.length }
}

/** `{result: {<key>: [...]}}` as herdr prints it; a missing list is an empty one. */
const herdrList = (parsed: unknown, key: string): unknown =>
  isRecord(parsed) && isRecord(parsed.result) ? (parsed.result[key] ?? []) : []

export const pickHerdrAgents = (parsed: unknown): Picked<HerdrAgentRaw> =>
  pickRows(herdrList(parsed, 'agents'), (row) => {
    const session = row.agent_session
    // A pane without a Claude session is valid: `null`, `{}` and `{ value: null }` all mean "no session".
    const sessionOk =
      session == null || (isRecord(session) && (session.value == null || typeof session.value === 'string'))
    return (
      sessionOk && typed(row, 'string', 'agent_status', 'cwd', 'pane_id', 'workspace_id', 'terminal_title_stripped')
    )
  })

export const pickHerdrWorkspaces = (parsed: unknown): Picked<HerdrWorkspaceRaw> =>
  pickRows(
    herdrList(parsed, 'workspaces'),
    (row) => typeof row.workspace_id === 'string' && typeof row.label === 'string',
  )

export const pickClaudeAgents = (parsed: unknown): Picked<ClaudeAgentRaw> =>
  pickRows(
    parsed,
    (row) => typed(row, 'string', 'cwd', 'sessionId', 'status', 'waitingFor') && typed(row, 'number', 'startedAt'),
  )

/**
 * The tail of a transcript file, growing the window while no line carries a timestamp. A single line (an
 * extended-thinking signature blob) larger than the window would otherwise push every parseable line out of reach.
 * File mtime is never a signal: Claude Code touches an idle session's file, so mtime means "the CLI is resident".
 * Never throws: a missing file is the all-null tail.
 */
export async function readTranscriptTailFile(path: string): Promise<TranscriptTail> {
  const file = Bun.file(path)
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return EMPTY_TAIL // a missing file
  }
  let attemptBytes = TAIL_BYTES
  let tail: TranscriptTail = EMPTY_TAIL
  for (;;) {
    const start = Math.max(0, size - attemptBytes)
    const raw = await file.slice(start, size).text()
    // The first line may be partial unless the read starts at byte 0.
    const firstNewline = raw.indexOf('\n')
    const text = start > 0 && firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw
    tail = parseTranscriptTail(text)
    if (tail.lastActivityAt != null) return tail
    if (start === 0 || attemptBytes >= MAX_TAIL_BYTES) return tail
    attemptBytes = Math.min(attemptBytes * 4, MAX_TAIL_BYTES)
  }
}

/** The last {@link LOG_TAIL_BYTES} of a log day file: a bounded async read; a partial first line fails to parse and is skipped. */
const LOG_TAIL_BYTES = 2 * 1024 * 1024
async function readLogTail(path: string): Promise<string> {
  const { size } = await stat(path)
  return Bun.file(path)
    .slice(Math.max(0, size - LOG_TAIL_BYTES), size)
    .text()
}

/** sessionId to account for every `session_env` line carrying an `account`; later lines win. */
export function parseSessionAccounts(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.includes('"session_env"')) continue
    try {
      const data = JSON.parse(line)?.data
      if (typeof data?.session === 'string' && typeof data?.account === 'string' && data.account) {
        out.set(data.session, data.account)
      }
    } catch {
      // a partial or foreign line
    }
  }
  return out
}

/** A session id is a path segment (a transcript): letters, digits, `_` and `-` only, never a separator or `..`. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

const SESSION_LOG_DAYS = 3
const MISS_RETRY_MS = 60_000
const MISS_RETRY_MAX_MS = 10 * 60_000
const MAX_TRACKED_SESSIONS = 2000

/** Drops the oldest-inserted entries until `map` is back at the cap. */
function capMap<V>(map: Map<string, V>): void {
  for (const key of map.keys()) {
    if (map.size <= MAX_TRACKED_SESSIONS) return
    map.delete(key)
  }
}

/**
 * Session to account from the `session_env` line in the newest log days, behind one memo. An
 * account never changes for a session, so a hit is kept for the process. A miss backs off (60 s to 10 min): the line
 * may not exist yet, and a session that never gets one must not cost a log scan per snapshot.
 */
export function sessionAccountResolver(config: Pick<FleetConfig, 'claudeLogDir'>) {
  const cache = new Map<string, string>()
  const misses = new Map<string, { at: number; n: number }>()
  return async (sessionIds: Iterable<string>, now: number): Promise<Map<string, string>> => {
    const result = new Map<string, string>()
    let missing: string[] = []
    for (const id of new Set(sessionIds)) {
      const hit = cache.get(id)
      if (hit) {
        result.set(id, hit)
        continue
      }
      const miss = misses.get(id)
      if (miss && now - miss.at < Math.min(MISS_RETRY_MS * 2 ** (miss.n - 1), MISS_RETRY_MAX_MS)) continue
      missing.push(id)
    }

    if (missing.length > 0) {
      try {
        const files = (await readdir(config.claudeLogDir))
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
          .toSorted()
          .toReversed()
          .slice(0, SESSION_LOG_DAYS)
        for (const file of files) {
          const found = parseSessionAccounts(await readLogTail(join(config.claudeLogDir, file)))
          for (const id of missing) {
            const account = found.get(id)
            if (account) {
              cache.set(id, account)
              result.set(id, account)
            }
          }
          missing = missing.filter((id) => !result.has(id))
          if (missing.length === 0) break
        }
      } catch {
        // no log dir: everything stays unknown
      }
      for (const id of missing) misses.set(id, { at: now, n: (misses.get(id)?.n ?? 0) + 1 })
      capMap(misses)
    }
    for (const id of result.keys()) misses.delete(id)
    capMap(cache)
    return result
  }
}

/** Branch, dirtiness, ahead/behind and the newest commit of the checkout at `cwd`; null when it is not a git repo. */
export async function gitProject(run: RunCommand, cwd: string): Promise<ProjectGit | null> {
  if (cwd === '') return null // `git -C ''` would read the host's own directory
  const g = (args: string[], options: { timeoutMs?: number; network?: boolean } = {}) =>
    run(['git', '-C', cwd, ...args], options)
  const [, branchOut, status, symbolicRef] = await Promise.all([
    g(['fetch', '--quiet', '--prune'], { timeoutMs: GIT_FETCH_TIMEOUT_MS, network: true }), // refreshes the remote-tracking refs behind ahead/behind
    g(['rev-parse', '--abbrev-ref', 'HEAD']),
    g(['status', '--porcelain']),
    g(['symbolic-ref', 'refs/remotes/origin/HEAD']),
  ])
  const branch = cleanLine(branchOut?.trim())
  if (!branch) return null
  const mainBranch = symbolicRef ? (symbolicRef.trim().split('/').pop() ?? 'main') : 'main'
  const format = '--format=%h%n%s%n%cI'
  const [aheadBehind, branchLog, mainLog] = await Promise.all([
    g(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    g(['log', `${mainBranch}..HEAD`, '-n', '1', format, '--']),
    g(['log', mainBranch, '-n', '1', format, '--']),
  ])
  const [ahead = 0, behind = 0] = (aheadBehind?.trim().split(/\s+/) ?? []).map((n) => Number.parseInt(n, 10) || 0)
  const commit = (out: string | null) => {
    const [sha, subject, at] = out?.trim().split('\n') ?? []
    return sha ? { sha: cleanLine(sha) ?? '', subject: cleanLine(subject) ?? '', at: cleanLine(at) ?? '' } : null
  }
  return {
    branch,
    dirty: (status ?? '').split('\n').some((line) => line.trim() !== ''),
    ahead,
    behind,
    lastCommit: commit(branchLog) ?? commit(mainLog),
  }
}

/** What `buildSnapshot` reads. Production: `defaultCollectors`; tests: fakes. */
export interface Collectors {
  herdrAgents(): Promise<CollectorResult<HerdrAgentRaw>>
  herdrWorkspaces(): Promise<CollectorResult<HerdrWorkspaceRaw>>
  claudeAgents(): Promise<CollectorResult<ClaudeAgentRaw>>
  humanQueue(): Promise<CollectorResult<HumanQueueEntry>>
  transcriptTail(cwd: string, sessionId: string): Promise<TranscriptTail>
  sessionAccounts(sessionIds: Iterable<string>, now: number): Promise<Map<string, string>>
  git(cwd: string): Promise<ProjectGit | null>
}

export function defaultCollectors(
  config: FleetConfig,
  run: RunCommand = runCommand,
  options: { warn?: (message: string, meta: Record<string, unknown>) => void } = {},
): Collectors {
  const resolveAccounts = sessionAccountResolver(config)
  return {
    herdrAgents: () => readJsonCommand(run, [config.herdrBin, 'agent', 'list'], 'herdr agent list', pickHerdrAgents),
    herdrWorkspaces: () =>
      readJsonCommand(run, [config.herdrBin, 'workspace', 'list'], 'herdr workspace list', pickHerdrWorkspaces),
    claudeAgents: () =>
      readJsonCommand(run, [config.claudeBin, 'agents', '--json'], 'claude agents --json', pickClaudeAgents),
    humanQueue: () => readHumanQueue(config.humanQueueDir),
    async transcriptTail(cwd, sessionId) {
      if (cwd === '' || !SESSION_ID_RE.test(sessionId)) return EMPTY_TAIL // a session id from outside is a path segment
      const path = join(config.claudeProjectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`)
      try {
        return await readTranscriptTailFile(path)
      } catch (error) {
        options.warn?.('session transcript tail read failed', { cwd, sessionId, error: String(error) })
        return EMPTY_TAIL
      }
    },
    sessionAccounts: resolveAccounts,
    git: (cwd) => gitProject(run, cwd),
  }
}

/** At most this many transcript tails and git statuses run at once: a fleet of dozens must not fork dozens of processes. */
const POOL_SIZE = 8

/** `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function summarize(projects: Snapshot['projects']): Summary {
  const summary: Summary = { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 }
  for (const project of projects) {
    for (const agent of project.agents) {
      if (agent.state === 'needs_you') summary.needsYou += 1
      else if (agent.state === 'working') summary.working += 1
      else if (agent.state === 'idle') summary.idle += 1
      else if (agent.state === 'stale') summary.stale += 1
      else if (agent.state === 'done') summary.done += 1
    }
  }
  return summary
}

/** One deterministic snapshot: the collectors merged, grouped by project, urgency-sorted, with git status per project. */
export async function buildSnapshot(
  collectors: Collectors,
  options: { now?: number; staleAfterHours: number },
): Promise<Snapshot> {
  const staleAfterMs = options.staleAfterHours * 60 * 60 * 1000

  const [herdrAgents, herdrWorkspaces, claudeAgents] = await Promise.all([
    collectors.herdrAgents(),
    collectors.herdrWorkspaces(),
    collectors.claudeAgents(),
  ])
  const humanQueue = await collectors.humanQueue()
  const warnings = [herdrAgents.warning, herdrWorkspaces.warning, claudeAgents.warning, humanQueue.warning].filter(
    (w): w is string => w != null,
  )

  // Unique (session, cwd) pairs across both sources: a herdr pane and its registry entry share a session and one tail read.
  const cwdBySession = new Map<string, string>()
  for (const a of herdrAgents.items) {
    const sessionId = a.agent_session?.value
    if (sessionId) cwdBySession.set(sessionId, a.cwd ?? '')
  }
  for (const c of claudeAgents.items) {
    if (c.sessionId && (c.cwd || !cwdBySession.has(c.sessionId))) cwdBySession.set(c.sessionId, c.cwd ?? '')
  }

  const transcripts = new Map(
    await mapPool(
      [...cwdBySession],
      POOL_SIZE,
      async ([sessionId, cwd]): Promise<[string, TranscriptTail]> => [
        sessionId,
        cwd === '' ? EMPTY_TAIL : await collectors.transcriptTail(cwd, sessionId), // no cwd, no transcript directory
      ],
    ),
  )

  // The snapshot's time is taken after the tails are read: a line a tail carries is never newer than the snapshot, so a
  // verdict is only called stale for activity the model could not have seen. A caller-set clock (the cache) is kept.
  const now = options.now ?? Date.now()

  const accounts = await collectors.sessionAccounts(cwdBySession.keys(), now)

  const merged = mergeAgents({
    herdrAgents: herdrAgents.items,
    herdrWorkspaces: herdrWorkspaces.items,
    claudeAgents: claudeAgents.items,
    transcripts,
    accounts,
    now,
    staleAfterMs,
  })

  const projects = await mapPool(merged, POOL_SIZE, async (project) => {
    let git: ProjectGit | null = null
    try {
      git = project.gitCwd == null ? null : await collectors.git(project.gitCwd) // the raw cwd, never the display one
    } catch (error) {
      warnings.push(`git status failed for ${project.name}: ${String(error)}`)
    }
    return { name: project.name || basename(project.cwd), cwd: project.cwd, git, agents: project.agents }
  })

  return {
    generatedAt: now,
    staleAfterHours: options.staleAfterHours,
    summary: summarize(projects),
    projects,
    humanQueue: humanQueue.items,
    warnings,
  }
}
