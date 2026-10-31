import { basename } from 'node:path'
import type { Agent, AgentState, ClaudeAgentStatus, HerdrAgentStatus } from './schema.ts'
import { hasControlBytes, oneLine, stripControlBytes } from './text.ts'

// Pure steps of the snapshot: what a transcript tail says, an agent's urgency, and the merge of the collectors.

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
}

/**
 * First match wins:
 * - needs_you: herdr `blocked`, or claude `waiting`
 * - working: herdr `working`, or claude `busy`
 * - stale: herdr `idle` / `done` and the last activity older than `staleAfterMs`
 * - idle: herdr `idle`; done: herdr `done`
 * - unknown: anything else
 */
export function deriveState(input: DeriveStateInput): AgentState {
  const { herdrStatus, claudeStatus, lastActivityAt, now, staleAfterMs } = input

  if (herdrStatus === 'blocked' || claudeStatus === 'waiting') return 'needs_you'
  if (herdrStatus === 'working' || claudeStatus === 'busy') return 'working'

  if (
    (herdrStatus === 'idle' || herdrStatus === 'done') &&
    lastActivityAt != null &&
    now - lastActivityAt > staleAfterMs
  ) {
    return 'stale'
  }
  if (herdrStatus === 'idle') return 'idle'
  if (herdrStatus === 'done') return 'done'
  return 'unknown'
}

/** What herdr and Claude's registry answer; a row may lack any field but the identifying one, and the merge copes. */
export interface HerdrAgentRaw {
  /** A pane with no Claude session reports `null`, `{}` or `{ value: null }`. */
  agent_session?: { value?: string | null } | null
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

/** One hc terminal as `terminal.list` answers it; only the fields the merge reads. */
export interface HcTerminalRaw {
  /** `t7`, or `machine/t7` for a linked machine's terminal. */
  address: string
  cwd?: string
  title?: string
  state?: string
  /** `herdr.space`, `jk.claude.session`, ... Values that are not strings are dropped by the collector. */
  labels?: Record<string, string>
  foreground?: { cwd?: string } | null
  /** The program's own OSC 7501 word; null until it ever reported. */
  status?: { app?: string; state?: string; title?: string } | null
}

/** One space of the `herdr-app` doc. */
export interface HcSpaceRaw {
  id: string
  name: string
}

export interface ClaudeAgentRaw {
  cwd?: string
  sessionId?: string
  startedAt?: number
  status?: string
  waitingFor?: string
}

export interface MergeAgentsInput {
  herdrAgents: HerdrAgentRaw[]
  herdrWorkspaces: HerdrWorkspaceRaw[]
  /** Absent: no hc world was collected. */
  hcTerminals?: HcTerminalRaw[]
  hcSpaces?: HcSpaceRaw[]
  claudeAgents: ClaudeAgentRaw[]
  /** Transcript tails by Claude session id: reading them is I/O, so the caller resolves them first. */
  transcripts: Map<string, TranscriptTail>
  /** Session id to account id. Absent: every account unknown. */
  accounts?: Map<string, string>
  now: number
  staleAfterMs: number
}

export interface MergedProject {
  name: string
  /** For display (Argo, the render, the model): one line, no control bytes. */
  cwd: string
  /** The checkout to run git in: the raw cwd, or null when it is empty or carries a control byte or a line break. */
  gitCwd: string | null
  agents: Agent[]
}

/** An identifier used as a key or a lookup (session, pane, workspace): itself when it is already one clean line, else null. */
const safeId = (raw: string | null | undefined): string | null => (raw && cleanLine(raw) === raw ? raw : null)

const normalizeHerdrStatus = (raw: string): HerdrAgentStatus =>
  raw === 'working' || raw === 'idle' || raw === 'blocked' || raw === 'done' ? raw : 'unknown'

const normalizeClaudeStatus = (raw: string): ClaudeAgentStatus | null =>
  raw === 'idle' || raw === 'busy' || raw === 'waiting' ? raw : null

/** The label the Claude SessionStart hook sets on its terminal: the resume id, and the only place hc carries a session id. */
export const HC_SESSION_LABEL = 'jk.claude.session'
/** The label that files a terminal into a space of the `herdr-app` doc. */
export const HC_SPACE_LABEL = 'herdr.space'

/** A live terminal whose program reported through OSC 7501 is an agent; a bare shell, or a finished terminal, is not. */
export const isHcAgent = (t: HcTerminalRaw): boolean => t.state !== 'finished' && !!t.status?.state

/** The generic `✳ Claude Code` banner says nothing; anything else loses only its leading symbols and spaces (`(wip)` and `#42` keep their punctuation). */
function hcTitle(raw: string | undefined): string | null {
  const title = cleanLine(raw)?.replace(/^[^\p{L}\p{N}\p{P}]+/u, '') ?? ''
  return title === '' || /^claude code$/i.test(title) ? null : title
}

/** Urgency of a terminal's own status, lower first. */
const HC_STATUS_RANK: Record<HerdrAgentStatus, number> = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 }

const STATE_RANK: Record<AgentState, number> = { needs_you: 0, working: 1, idle: 2, stale: 3, done: 4, unknown: 5 }

/**
 * Merges the collectors into one project-grouped, urgency-sorted list. Entries are keyed by Claude session id: a
 * herdr pane and the claude registry entry of the same session collapse into one agent, herdr's status winning.
 */
export function mergeAgents(input: MergeAgentsInput): MergedProject[] {
  const { herdrAgents, herdrWorkspaces, claudeAgents, transcripts, accounts, now, staleAfterMs } = input
  const workspaceLabels = new Map(herdrWorkspaces.map((w) => [w.workspace_id, w.label]))
  const hcSpaceNames = new Map((input.hcSpaces ?? []).map((space) => [space.id, space.name]))

  interface Entry {
    agent: Agent
    workspaceId: string | null
    cwd: string
    /** The two worlds' ids are separate namespaces: an hc space id never looks up a herdr workspace. */
    hc?: boolean
    /** A linked machine's terminal: its cwd is a path on that machine, so nothing on this host reads it as one. */
    remote?: boolean
  }
  const entries = new Map<string, Entry>()

  // TODO(Wave 7): drop classic herdr
  for (const a of herdrAgents) {
    // Keys and lookups use the raw value; a value that cleaning would change cannot be one (a UUID never is).
    const rawSession = a.agent_session?.value ?? null
    const sessionId = safeId(rawSession)
    if (rawSession && !sessionId) continue
    const paneId = safeId(a.pane_id)
    const workspaceId = safeId(a.workspace_id)
    if (!sessionId && !paneId) continue // nothing to identify the row by
    const tail = sessionId ? (transcripts.get(sessionId) ?? EMPTY_TAIL) : EMPTY_TAIL
    entries.set(sessionId ?? `pane:${paneId}`, {
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
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        account: sessionId ? cleanLine(accounts?.get(sessionId)) || null : null,
        startedAt: null,
      },
    })
  }

  // hc after classic herdr: a session both worlds report (a resumed one) is the hc terminal from here on.
  for (const t of input.hcTerminals ?? []) {
    if (!isHcAgent(t)) continue
    const address = safeId(t.address)
    if (!address) continue
    const rawSession = t.labels?.[HC_SESSION_LABEL] || null
    const sessionId = safeId(rawSession)
    if (rawSession && !sessionId) continue
    const workspaceId = safeId(t.labels?.[HC_SPACE_LABEL])
    const tail = sessionId ? (transcripts.get(sessionId) ?? EMPTY_TAIL) : EMPTY_TAIL
    const herdrStatus = normalizeHerdrStatus(t.status?.state ?? '')
    // One session in two live terminals: the more urgent status stands, so a blocked one is never hidden by an idle one.
    const existing = sessionId ? entries.get(sessionId) : undefined
    if (existing?.hc && HC_STATUS_RANK[herdrStatus] >= HC_STATUS_RANK[existing.agent.herdrStatus ?? 'unknown']) continue
    entries.set(sessionId ?? `hc:${address}`, {
      workspaceId,
      cwd: t.foreground?.cwd || t.cwd || '',
      hc: true,
      remote: address.includes('/'),
      agent: {
        id: sessionId ?? address,
        source: 'hc',
        sessionId,
        paneId: address,
        workspaceId,
        title: hcTitle(t.status?.title) ?? hcTitle(t.title) ?? tail.aiTitle ?? null,
        state: 'unknown',
        herdrStatus,
        claudeStatus: null,
        waitingFor: null,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        account: sessionId ? cleanLine(accounts?.get(sessionId)) || null : null,
        startedAt: null,
      },
    })
  }

  for (const c of claudeAgents) {
    const sessionId = safeId(c.sessionId)
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
    const tail = transcripts.get(sessionId) ?? EMPTY_TAIL
    entries.set(sessionId, {
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
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        account: cleanLine(accounts?.get(sessionId)) || null,
        startedAt,
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
    })
    const names = entry.hc ? hcSpaceNames : workspaceLabels
    const label = entry.workspaceId ? names.get(entry.workspaceId) : undefined
    const projectName = cleanLine(label ?? basename(entry.cwd)) ?? ''
    const gitCwd = entry.cwd !== '' && !entry.remote && !hasControlBytes(entry.cwd) ? entry.cwd : null
    const group = groups.get(projectName)
    if (!group) {
      groups.set(projectName, { name: projectName, cwd: cleanLine(entry.cwd) ?? '', gitCwd, agents: [entry.agent] })
      continue
    }
    group.agents.push(entry.agent)
    if (group.gitCwd == null && gitCwd != null) Object.assign(group, { cwd: gitCwd, gitCwd }) // the first usable checkout stands
  }

  const rank = (g: MergedProject) => Math.min(...g.agents.map((a) => STATE_RANK[a.state]))
  return [...groups.values()].toSorted((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name))
}
