import { basename } from 'node:path'
import type {
  Agent,
  AgentSource,
  AgentState,
  ClaudeAgentStatus,
  DispatchTierName,
  HerdrAgentStatus,
  JobStatus,
} from './schema.ts'
import { oneLine, stripControlBytes } from './text.ts'

// Pure steps of the snapshot: what a transcript tail says, an agent's urgency, and the merge of the three collectors.

/** `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`: the absolute path with every non-alphanumeric turned to `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Text that came from outside (a transcript, a pane title, a branch name) never carries a control byte into a pane, Argo or a prompt. */
export const clean = (text: string | null | undefined): string | null => (text == null ? null : stripControlBytes(text))

/** {@link clean} for a field that is one line by nature (id, title, account, branch): CR/LF and runs of whitespace collapse too. */
export const cleanLine = (text: string | null | undefined): string | null => (text == null ? null : oneLine(text))

export interface TranscriptTail {
  lastPrompt: string | null
  aiTitle: string | null
  lastReply: string | null
  /** Epoch ms of the last assistant or user line's timestamp. */
  lastActivityAt: number | null
}

export const EMPTY_TAIL: TranscriptTail = { lastPrompt: null, aiTitle: null, lastReply: null, lastActivityAt: null }

/** The reply cap is the facts block's too (the model quotes `lastReply`), so one number serves both. */
const MAX_REPLY_CHARS = 800

/**
 * Parses the tail of a session's `.jsonl` transcript (already cut to the last N bytes, a leading partial line dropped).
 * Lines that are not JSON, and line types it does not care about, are skipped.
 */
export function parseTranscriptTail(text: string): TranscriptTail {
  let lastPrompt: string | null = null
  let aiTitle: string | null = null
  let lastReply: string | null = null
  let lastActivityAt: number | null = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    const type = record.type
    if (type === 'last-prompt' && typeof record.lastPrompt === 'string') {
      lastPrompt = record.lastPrompt
      continue
    }
    if (type === 'ai-title' && typeof record.aiTitle === 'string') {
      aiTitle = record.aiTitle
      continue
    }
    if (type !== 'assistant' && type !== 'user') continue

    if (typeof record.timestamp === 'string') {
      const ms = Date.parse(record.timestamp)
      if (!Number.isNaN(ms)) lastActivityAt = ms
    }

    if (type !== 'assistant') continue
    const content = (record.message as Record<string, unknown> | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      const text = b.text.trim()
      if (text) lastReply = text.slice(0, MAX_REPLY_CHARS)
    }
  }

  return {
    lastPrompt: clean(lastPrompt),
    aiTitle: cleanLine(aiTitle),
    lastReply: clean(lastReply),
    lastActivityAt,
  }
}

export interface DeriveStateInput {
  herdrStatus: HerdrAgentStatus | null
  claudeStatus: ClaudeAgentStatus | null
  lastActivityAt: number | null
  now: number
  staleAfterMs: number
  source: AgentSource
  jobStatus: JobStatus | null
}

/**
 * First match wins:
 * - needs_you: herdr `blocked`, or claude `waiting`
 * - working: herdr `working`, claude `busy`, or a dispatch job `running` / `pending`
 * - stale: herdr `idle` / `done` and the last activity older than `staleAfterMs`
 * - idle: herdr `idle`; done: herdr `done`, or a terminal dispatch job
 * - unknown: anything else
 *
 * A dispatch job never resolves to `needs_you`: the needs-human verdict is not in the job list.
 */
export function deriveState(input: DeriveStateInput): AgentState {
  const { herdrStatus, claudeStatus, lastActivityAt, now, staleAfterMs, source, jobStatus } = input

  if (herdrStatus === 'blocked' || claudeStatus === 'waiting') return 'needs_you'
  if (herdrStatus === 'working' || claudeStatus === 'busy') return 'working'
  if (source === 'dispatch' && (jobStatus === 'running' || jobStatus === 'pending')) return 'working'

  if (
    (herdrStatus === 'idle' || herdrStatus === 'done') &&
    lastActivityAt != null &&
    now - lastActivityAt > staleAfterMs
  ) {
    return 'stale'
  }
  if (herdrStatus === 'idle') return 'idle'
  if (herdrStatus === 'done') return 'done'
  if (source === 'dispatch' && jobStatus != null && jobStatus !== 'running' && jobStatus !== 'pending') return 'done'
  return 'unknown'
}

/** What herdr and Claude's registry answer; a row may lack any field but the identifying one, and the merge copes. */
export interface HerdrAgentRaw {
  agent_session?: { value: string } | null
  agent_status?: string
  cwd?: string
  pane_id?: string
  workspace_id?: string
  terminal_title_stripped?: string
}

export interface HerdrWorkspaceRaw {
  workspace_id: string
  label: string
}

export interface ClaudeAgentRaw {
  cwd?: string
  sessionId?: string
  startedAt?: number
  status?: string
  waitingFor?: string
}

export interface DispatchJobRaw {
  id: string
  status: JobStatus
  cwd: string
  tier: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  /** The worker's Claude session id, once known. */
  sessionId?: string | null
  /** The account of the session; filled by the snapshot builder. */
  account?: string | null
}

export interface MergeAgentsInput {
  herdrAgents: HerdrAgentRaw[]
  herdrWorkspaces: HerdrWorkspaceRaw[]
  claudeAgents: ClaudeAgentRaw[]
  dispatchJobs: DispatchJobRaw[]
  /** Transcript tails by Claude session id: reading them is I/O, so the caller resolves them first. */
  transcripts: Map<string, TranscriptTail>
  /** Session id to account id. Absent: every account unknown. */
  accounts?: Map<string, string>
  now: number
  staleAfterMs: number
}

export interface MergedProject {
  name: string
  cwd: string
  agents: Agent[]
}

const normalizeHerdrStatus = (raw: string): HerdrAgentStatus =>
  raw === 'working' || raw === 'idle' || raw === 'blocked' || raw === 'done' ? raw : 'unknown'

const normalizeClaudeStatus = (raw: string): ClaudeAgentStatus | null =>
  raw === 'idle' || raw === 'busy' || raw === 'waiting' ? raw : null

const normalizeTier = (raw: string | null): DispatchTierName | null =>
  raw === 'investigate' || raw === 'author' || raw === 'implement' ? raw : null

const STATE_RANK: Record<AgentState, number> = { needs_you: 0, working: 1, idle: 2, stale: 3, done: 4, unknown: 5 }

/**
 * Merges the three collectors into one project-grouped, urgency-sorted list. Entries are keyed by Claude session id: a
 * herdr pane and the claude registry entry of the same session collapse into one agent, herdr's status winning.
 * Dispatch jobs have no session key and are always their own entry.
 */
export function mergeAgents(input: MergeAgentsInput): MergedProject[] {
  const { herdrAgents, herdrWorkspaces, claudeAgents, dispatchJobs, transcripts, accounts, now, staleAfterMs } = input
  const workspaceLabels = new Map(herdrWorkspaces.map((w) => [w.workspace_id, w.label]))

  interface Entry {
    agent: Agent
    jobStatus: JobStatus | null
    workspaceId: string | null
    cwd: string
  }
  const entries = new Map<string, Entry>()

  for (const a of herdrAgents) {
    const rawSession = a.agent_session?.value ?? null
    const sessionId = cleanLine(rawSession) || null
    const paneId = cleanLine(a.pane_id) || null
    const workspaceId = cleanLine(a.workspace_id) || null
    if (!sessionId && !paneId) continue // nothing to identify the row by
    const tail = rawSession ? (transcripts.get(rawSession) ?? EMPTY_TAIL) : EMPTY_TAIL
    entries.set(sessionId ?? `pane:${paneId}`, {
      jobStatus: null,
      workspaceId,
      cwd: a.cwd ?? '',
      agent: {
        id: sessionId ?? paneId ?? '',
        source: 'herdr',
        sessionId,
        paneId,
        workspaceId,
        title: cleanLine(a.terminal_title_stripped) || tail.aiTitle || null,
        state: 'unknown',
        herdrStatus: normalizeHerdrStatus(a.agent_status ?? ''),
        claudeStatus: null,
        waitingFor: null,
        tier: null,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        account: rawSession ? cleanLine(accounts?.get(rawSession)) || null : null,
        startedAt: null,
      },
    })
  }

  for (const c of claudeAgents) {
    if (typeof c.sessionId !== 'string') continue
    const sessionId = cleanLine(c.sessionId)
    if (!sessionId) continue
    const claudeStatus = normalizeClaudeStatus(c.status ?? '')
    const startedAt = typeof c.startedAt === 'number' ? c.startedAt : null
    const existing = entries.get(sessionId)
    if (existing) {
      existing.agent.claudeStatus = claudeStatus
      existing.agent.waitingFor = cleanLine(c.waitingFor)
      existing.agent.startedAt = startedAt
      continue
    }
    const tail = transcripts.get(c.sessionId) ?? EMPTY_TAIL
    entries.set(sessionId, {
      jobStatus: null,
      workspaceId: null,
      cwd: c.cwd ?? '',
      agent: {
        id: sessionId,
        source: 'claude',
        sessionId,
        paneId: null,
        workspaceId: null,
        title: tail.aiTitle,
        state: 'unknown',
        herdrStatus: null,
        claudeStatus,
        waitingFor: cleanLine(c.waitingFor),
        tier: null,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        account: cleanLine(accounts?.get(c.sessionId)) || null,
        startedAt,
      },
    })
  }

  for (const job of dispatchJobs) {
    const jobId = cleanLine(job.id)
    if (!jobId) continue
    entries.set(`dispatch:${jobId}`, {
      jobStatus: job.status,
      workspaceId: null,
      cwd: job.cwd,
      agent: {
        id: jobId,
        source: 'dispatch',
        sessionId: null,
        paneId: null,
        workspaceId: null,
        title: null,
        state: 'unknown',
        herdrStatus: null,
        claudeStatus: null,
        waitingFor: null,
        tier: normalizeTier(job.tier),
        lastPrompt: null,
        lastReply: null,
        lastActivityAt: job.finishedAt ?? job.startedAt ?? job.createdAt,
        account: cleanLine(job.account) || null,
        startedAt: job.startedAt ?? job.createdAt,
      },
    })
  }

  const groups = new Map<string, MergedProject>()
  for (const entry of entries.values()) {
    entry.agent.state = deriveState({
      herdrStatus: entry.agent.herdrStatus,
      claudeStatus: entry.agent.claudeStatus,
      lastActivityAt: entry.agent.lastActivityAt,
      now,
      staleAfterMs,
      source: entry.agent.source,
      jobStatus: entry.jobStatus,
    })
    const label = entry.workspaceId ? workspaceLabels.get(entry.workspaceId) : undefined
    const projectName = cleanLine(label ?? basename(entry.cwd)) ?? ''
    const group = groups.get(projectName)
    if (group) group.agents.push(entry.agent)
    else groups.set(projectName, { name: projectName, cwd: cleanLine(entry.cwd) ?? '', agents: [entry.agent] })
  }

  const rank = (g: MergedProject) => Math.min(...g.agents.map((a) => STATE_RANK[a.state]))
  return [...groups.values()].toSorted((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name))
}
