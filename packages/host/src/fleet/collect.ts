import { existsSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type ClaudeAgentRaw,
  clean,
  type DispatchJobRaw,
  EMPTY_TAIL,
  encodeProjectDir,
  type HerdrAgentRaw,
  type HerdrWorkspaceRaw,
  mergeAgents,
  parseTranscriptTail,
  type TranscriptTail,
} from './derive.ts'
import type { HumanQueueEntry, ProjectGit, Snapshot, Summary } from './schema.ts'
import { stripControlBytes } from './text.ts'

// The impure half of the snapshot: herdr and Claude's registry, transcript tails, the human queue, session accounts,
// git status and agent-gateway's dispatch jobs. Every one is a port, so tests run the whole builder on fakes.

const CLI_TIMEOUT_MS = 5_000
const TAIL_BYTES = 512 * 1024
const MAX_TAIL_BYTES = 8 * 1024 * 1024
const GIT_FETCH_TIMEOUT_MS = 5_000
const DISPATCH_HTTP_TIMEOUT_MS = 5_000
/** Dispatch jobs relevant to the overview: running or queued, plus terminal ones from the last 6 h. */
const DISPATCH_RECENT_MS = 6 * 60 * 60 * 1000
const DEFAULT_STALE_HOURS = 24

export interface CollectorResult<T> {
  items: T[]
  warning: string | null
}

/** Runs a command and answers its stdout; `null` on a spawn error, a timeout or a non-zero exit. */
export type RunCommand = (cmd: string[], options?: { timeoutMs?: number }) => Promise<string | null>

/** What a child (git, herdr, claude) is given of the host's environment: never a secret the host holds. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG']

/** The command runner on `env`: children get {@link CHILD_ENV_KEYS} and no credential prompts, nothing else. */
export function commandRunner(env: Record<string, string | undefined> = process.env): RunCommand {
  const childEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }
  return async (cmd, options = {}) => {
    try {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', env: childEnv })
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
  /** agent-gateway's per-session account pins (written by its workers; read here). */
  sessionAccountsDir: string
  /** agent-gateway's HTTP base, for the dispatch jobs it still owns. */
  agentGatewayUrl: string
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
    sessionAccountsDir:
      env.AGW_SESSION_ACCOUNTS_DIR?.trim() || join(home, '.local', 'state', 'agent-gateway', 'session-accounts'),
    agentGatewayUrl: (env.AGW_AGENT_GATEWAY_URL?.trim() || 'http://localhost:7705').replace(/\/+$/, ''),
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
    id: typeof r.id === 'string' && r.id ? r.id : fallbackId,
    askedAt: typeof r.created === 'string' ? r.created : null,
    question: stripControlBytes(r.text),
    cmd: cmd || null,
  }
}

/** Pending requests in `dir`, newest first (ids sort chronologically). A missing directory is an empty queue, never a warning. */
export async function readHumanQueue(dir: string): Promise<CollectorResult<HumanQueueEntry>> {
  if (!existsSync(dir)) return { items: [], warning: null }
  try {
    const names = new Set(await readdir(dir))
    const items: HumanQueueEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.req') || name.startsWith('.')) continue
      const id = name.slice(0, -'.req'.length)
      if (names.has(`${id}.res`)) continue
      const entry = parseHumanQueueRequest(await readFile(join(dir, name), 'utf-8'), id)
      if (entry) items.push(entry)
    }
    items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return { items, warning: null }
  } catch (error) {
    return { items: [], warning: `human-queue read failed: ${String(error)}` }
  }
}

async function readJsonCommand<T>(
  run: RunCommand,
  cmd: string[],
  label: string,
  pick: (parsed: unknown) => T[],
): Promise<CollectorResult<T>> {
  const out = await run(cmd)
  if (out == null) return { items: [], warning: `${label} failed or timed out` }
  try {
    return { items: pick(JSON.parse(out)), warning: null }
  } catch {
    return { items: [], warning: `${label} returned unparseable JSON` }
  }
}

/**
 * The tail of a transcript file, growing the window while no line carries a timestamp. A single line (an
 * extended-thinking signature blob) larger than the window would otherwise push every parseable line out of reach.
 * File mtime is never a signal: Claude Code touches an idle session's file, so mtime means "the CLI is resident".
 * Never throws: a missing file is the all-null tail.
 */
export async function readTranscriptTailFile(path: string): Promise<TranscriptTail> {
  const file = Bun.file(path)
  if (!(await file.exists())) return EMPTY_TAIL
  const size = file.size
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
  const file = Bun.file(path)
  return file.slice(Math.max(0, file.size - LOG_TAIL_BYTES), file.size).text()
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

/** A session id is a path segment (a transcript, a pin): letters, digits, `_` and `-` only, never a separator or `..`. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

/** The account agent-gateway pinned for a session at spawn, or null when absent or unusable. */
export async function readSessionPin(dir: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null
  try {
    const path = join(dir, `${sessionId}.json`)
    if (!(await lstat(path)).isFile()) return null // never follow a symlink or read a directory
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (typeof raw?.account !== 'string' || raw.account === '') return null
    if (typeof raw.dir === 'string' && raw.dir !== '' && !existsSync(raw.dir)) return null // a pinned dir must still exist
    return raw.account
  } catch {
    return null
  }
}

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
 * Session to account, two sources behind one memo: the spawn pin, then the `session_env` line in the newest log days. An
 * account never changes for a session, so a hit is kept for the process. A miss backs off (60 s to 10 min): the line
 * may not exist yet, and a session that never gets one must not cost a log scan per snapshot.
 */
export function sessionAccountResolver(config: Pick<FleetConfig, 'claudeLogDir' | 'sessionAccountsDir'>) {
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
      const pinned = await readSessionPin(config.sessionAccountsDir, id)
      if (pinned) {
        cache.set(id, pinned)
        result.set(id, pinned)
      } else {
        missing.push(id)
      }
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
  const g = (args: string[], timeoutMs?: number) => run(['git', '-C', cwd, ...args], timeoutMs ? { timeoutMs } : {})
  const [, branchOut, status, symbolicRef] = await Promise.all([
    g(['fetch', '--quiet', '--prune'], GIT_FETCH_TIMEOUT_MS), // refreshes the remote-tracking refs behind ahead/behind
    g(['rev-parse', '--abbrev-ref', 'HEAD']),
    g(['status', '--porcelain']),
    g(['symbolic-ref', 'refs/remotes/origin/HEAD']),
  ])
  const branch = clean(branchOut?.trim())
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
    return sha
      ? { sha: clean(sha.trim()) ?? '', subject: clean((subject ?? '').trim()) ?? '', at: (at ?? '').trim() }
      : null
  }
  return {
    branch,
    dirty: (status ?? '').split('\n').some((line) => line.trim() !== ''),
    ahead,
    behind,
    lastCommit: commit(branchLog) ?? commit(mainLog),
  }
}

interface JobListEntry {
  id: string
  tool: string
  status: DispatchJobRaw['status']
  createdAt: number
  finishedAt: number | null
}

/**
 * agent-gateway's dispatch jobs, read-only over its HTTP: the list names the jobs, and a relevant one is fetched for its
 * params (cwd, tier) and session id, which the list view leaves out. A jobs-less agent-gateway is a warning, not a failure.
 */
export async function readDispatchJobs(
  baseUrl: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<CollectorResult<DispatchJobRaw>> {
  const get = async (path: string) => {
    const res = await fetcher(`${baseUrl}${path}`, { signal: AbortSignal.timeout(DISPATCH_HTTP_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }
  try {
    const list = ((await get('/api/jobs')).jobs ?? []) as JobListEntry[]
    const relevant = list.filter((job) => {
      if (job.tool !== 'dispatch') return false
      if (job.status === 'running' || job.status === 'pending') return true
      return now - (job.finishedAt ?? job.createdAt) <= DISPATCH_RECENT_MS
    })
    const details = await Promise.allSettled(relevant.map((entry) => get(`/api/jobs/${encodeURIComponent(entry.id)}`)))
    const items: DispatchJobRaw[] = []
    let failed = 0
    for (const detail of details) {
      if (detail.status === 'rejected') {
        failed += 1
        continue
      }
      const job = detail.value.job as
        | (JobListEntry & { params?: Record<string, unknown>; startedAt?: number | null; sessionId?: string | null })
        | undefined
      const cwd = typeof job?.params?.cwd === 'string' ? job.params.cwd : ''
      if (!job || cwd === '') continue
      items.push({
        id: job.id,
        status: job.status,
        cwd,
        tier: typeof job.params?.tier === 'string' ? job.params.tier : null,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt,
        sessionId: job.sessionId ?? null,
      })
    }
    if (failed > 0) {
      return { items, warning: `agent-gateway dispatch jobs: ${failed} of ${relevant.length} could not be read` }
    }
    return { items, warning: null }
  } catch (error) {
    return {
      items: [],
      warning: `agent-gateway dispatch jobs unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** What `buildSnapshot` reads. Production: `defaultCollectors`; tests: fakes. */
export interface Collectors {
  herdrAgents(): Promise<CollectorResult<HerdrAgentRaw>>
  herdrWorkspaces(): Promise<CollectorResult<HerdrWorkspaceRaw>>
  claudeAgents(): Promise<CollectorResult<ClaudeAgentRaw>>
  humanQueue(): Promise<CollectorResult<HumanQueueEntry>>
  transcriptTail(cwd: string, sessionId: string): Promise<TranscriptTail>
  dispatchJobs(now: number): Promise<CollectorResult<DispatchJobRaw>>
  sessionAccounts(sessionIds: Iterable<string>, now: number): Promise<Map<string, string>>
  git(cwd: string): Promise<ProjectGit | null>
}

export function defaultCollectors(
  config: FleetConfig,
  run: RunCommand = runCommand,
  options: { fetcher?: typeof fetch; warn?: (message: string, meta: Record<string, unknown>) => void } = {},
): Collectors {
  const resolveAccounts = sessionAccountResolver(config)
  return {
    herdrAgents: () =>
      readJsonCommand(run, [config.herdrBin, 'agent', 'list'], 'herdr agent list', (parsed) => {
        const agents = (parsed as { result?: { agents?: unknown[] } }).result?.agents ?? []
        return agents as HerdrAgentRaw[]
      }),
    herdrWorkspaces: () =>
      readJsonCommand(run, [config.herdrBin, 'workspace', 'list'], 'herdr workspace list', (parsed) => {
        const workspaces = (parsed as { result?: { workspaces?: unknown[] } }).result?.workspaces ?? []
        return workspaces as HerdrWorkspaceRaw[]
      }),
    claudeAgents: () =>
      readJsonCommand(run, [config.claudeBin, 'agents', '--json'], 'claude agents --json', (parsed) => {
        if (!Array.isArray(parsed)) throw new Error('not a list')
        return parsed as ClaudeAgentRaw[]
      }),
    humanQueue: () => readHumanQueue(config.humanQueueDir),
    async transcriptTail(cwd, sessionId) {
      if (!SESSION_ID_RE.test(sessionId)) return EMPTY_TAIL // a session id from outside is a path segment
      const path = join(config.claudeProjectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`)
      try {
        return await readTranscriptTailFile(path)
      } catch (error) {
        options.warn?.('session transcript tail read failed', { cwd, sessionId, error: String(error) })
        return EMPTY_TAIL
      }
    },
    dispatchJobs: (now) => readDispatchJobs(config.agentGatewayUrl, now, options.fetcher),
    sessionAccounts: resolveAccounts,
    git: (cwd) => gitProject(run, cwd),
  }
}

function summarize(projects: Snapshot['projects']): Summary {
  const summary: Summary = { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 }
  for (const project of projects) {
    for (const agent of project.agents) {
      if (agent.source === 'dispatch') summary.dispatch += 1
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
  const now = options.now ?? Date.now()
  const staleAfterMs = options.staleAfterHours * 60 * 60 * 1000

  const [herdrAgents, herdrWorkspaces, claudeAgents] = await Promise.all([
    collectors.herdrAgents(),
    collectors.herdrWorkspaces(),
    collectors.claudeAgents(),
  ])
  const humanQueue = await collectors.humanQueue()
  const dispatch = await collectors.dispatchJobs(now)
  const warnings = [
    herdrAgents.warning,
    herdrWorkspaces.warning,
    claudeAgents.warning,
    humanQueue.warning,
    dispatch.warning,
  ].filter((w): w is string => w != null)

  // Unique (session, cwd) pairs across both sources: a herdr pane and its registry entry share a session and one tail read.
  const cwdBySession = new Map<string, string>()
  for (const a of herdrAgents.items) {
    const sessionId = a.agent_session?.value
    if (sessionId) cwdBySession.set(sessionId, a.cwd ?? '')
  }
  for (const c of claudeAgents.items) if (c.sessionId) cwdBySession.set(c.sessionId, c.cwd ?? '')

  const transcripts = new Map(
    await Promise.all(
      [...cwdBySession].map(
        async ([sessionId, cwd]): Promise<[string, TranscriptTail]> => [
          sessionId,
          await collectors.transcriptTail(cwd, sessionId),
        ],
      ),
    ),
  )

  // One resolve for panes and dispatch workers alike: only rows that have a session id.
  const accounts = await collectors.sessionAccounts(
    [...cwdBySession.keys(), ...dispatch.items.flatMap((j) => (j.sessionId ? [j.sessionId] : []))],
    now,
  )
  const dispatchJobs = dispatch.items.map((j) => ({
    ...j,
    account: j.sessionId ? (accounts.get(j.sessionId) ?? null) : null,
  }))

  const merged = mergeAgents({
    herdrAgents: herdrAgents.items,
    herdrWorkspaces: herdrWorkspaces.items,
    claudeAgents: claudeAgents.items,
    dispatchJobs,
    transcripts,
    accounts,
    now,
    staleAfterMs,
  })

  const projects = await Promise.all(
    merged.map(async (project) => {
      let git: ProjectGit | null = null
      try {
        git = await collectors.git(project.cwd)
      } catch (error) {
        warnings.push(`git status failed for ${project.name}: ${String(error)}`)
      }
      return { name: project.name || basename(project.cwd), cwd: project.cwd, git, agents: project.agents }
    }),
  )

  return {
    generatedAt: now,
    staleAfterHours: options.staleAfterHours,
    summary: summarize(projects),
    projects,
    humanQueue: humanQueue.items,
    warnings,
  }
}
