import type { FactoryFleet, FactorySession } from './factory.ts'
import type { Agent, AgentState, HerdrAgentStatus, HumanQueueEntry, Project, Snapshot, Summary } from './schema.ts'
import { oneLine, stripControlBytes } from './text.ts'

// Pure steps of the snapshot: the factory's fleet view mapped onto the overview's shapes, and the urgency state of one agent.

/** Text that came from outside (a title, a headline, an ask) never carries a control byte into a pane, Argo or a prompt. */
export const clean = (text: string | null | undefined): string | null => (text == null ? null : stripControlBytes(text))

/** {@link clean} for a field that is one line by nature (id, title, account, branch): CR/LF and runs of whitespace collapse too. */
export const cleanLine = (text: string | null | undefined): string | null => (text == null ? null : oneLine(text))

/** The unplaced sessions' project: live sessions the factory cannot file under a repo, and has no directory for. */
export const UNPLACED_PROJECT = 'unplaced'

const NEEDS_YOU_STATES = new Set<FactorySession['state']>(['waiting', 'blocked', 'walled', 'stuck'])
/** A session parked on workers it started or on a deploy is waiting on machines, not on the owner. */
const MANAGED_WAITS = new Set(['workers', 'deploy'])

const STATE_RANK: Record<AgentState, number> = { needs_you: 0, working: 1, idle: 2, stale: 3, done: 4, unknown: 5 }

const epochMs = (iso: string | null): number | null => {
  if (iso == null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

const normalizeHerdrStatus = (raw: string | null): HerdrAgentStatus | null =>
  raw == null ? null : raw === 'working' || raw === 'idle' || raw === 'blocked' || raw === 'done' ? raw : 'unknown'

/**
 * The one urgency state, first match wins:
 * - needs_you: factory state `waiting` / `blocked` / `walled` / `stuck` (except a managed wait: `workers`, `deploy`), or hc `blocked`
 * - working: `working` / `starting`
 * - stale: idle (a managed wait included) or hc `done`, and the last activity older than `staleAfterMs`
 * - done: hc `done`; idle: everything else that is not working
 */
export function deriveState(input: {
  session: Pick<FactorySession, 'state' | 'hc' | 'wait'>
  lastActivityAt: number | null
  now: number
  staleAfterMs: number
}): AgentState {
  const { session, lastActivityAt, now, staleAfterMs } = input
  const managed = session.state === 'waiting' && session.wait != null && MANAGED_WAITS.has(session.wait)
  if (!managed && (NEEDS_YOU_STATES.has(session.state) || session.hc === 'blocked')) return 'needs_you'
  if (session.state === 'working' || session.state === 'starting') return 'working'
  if (lastActivityAt != null && now - lastActivityAt > staleAfterMs) return 'stale'
  return session.hc === 'done' ? 'done' : 'idle'
}

/** The generic `✳ Claude Code` banner says nothing; anything else loses only its leading symbols and spaces (`(wip)` and `#42` keep their punctuation). */
function agentTitle(raw: string | null): string | null {
  const title = cleanLine(raw)?.replace(/^[^\p{L}\p{N}\p{P}]+/u, '') ?? ''
  return title === '' || /^claude code$/i.test(title) ? null : title
}

/** An identifier used as a key: itself when it is already one clean line, else null (the row is dropped). */
const safeId = (raw: string | null): string | null => (raw && cleanLine(raw) === raw ? raw : null)

function toAgent(session: FactorySession, now: number, staleAfterMs: number): Agent | null {
  const id = safeId(session.id)
  if (!id) return null
  const lastActivityAt = epochMs(session.lastActivityAt)
  return {
    id,
    source: 'factory',
    sessionId: id,
    paneId: cleanLine(session.terminal) || null,
    workspaceId: null,
    title: agentTitle(session.title),
    state: deriveState({ session, lastActivityAt, now, staleAfterMs }),
    herdrStatus: normalizeHerdrStatus(session.hc),
    claudeStatus: null,
    waitingFor: cleanLine(session.wait) || null,
    lastPrompt: null,
    lastReply: clean(session.headline),
    lastActivityAt,
    account: cleanLine(session.account) || null,
    startedAt: epochMs(session.since),
    plan: cleanLine(session.plan) || null,
    wave: session.wave,
  }
}

function summarize(projects: Project[]): Summary {
  const summary: Summary = { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0 }
  for (const agent of projects.flatMap((p) => p.agents)) {
    if (agent.state === 'needs_you') summary.needsYou += 1
    else if (agent.state === 'working') summary.working += 1
    else if (agent.state === 'idle') summary.idle += 1
    else if (agent.state === 'stale') summary.stale += 1
    else if (agent.state === 'done') summary.done += 1
  }
  return summary
}

const byUrgency = (x: Agent, y: Agent) =>
  STATE_RANK[x.state] - STATE_RANK[y.state] || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0)

/**
 * The factory's fleet view as the overview snapshot. A repo becomes a project when it has a session (an overview is of
 * agents; the factory lists every repo it knows). Sessions the factory could not place form one `unplaced` project: the
 * view gives them no directory. Projects are urgency-sorted, as the collectors' merge sorted them.
 */
export function mapFleet(
  fleet: FactoryFleet,
  options: { now: number; staleAfterHours: number; warnings?: string[] },
): Snapshot {
  const { now } = options
  const staleAfterMs = options.staleAfterHours * 60 * 60 * 1000
  const seen = new Set<string>()
  const agentsOf = (sessions: FactorySession[]): Agent[] =>
    sessions
      .map((s) => toAgent(s, now, staleAfterMs))
      .filter((a): a is Agent => {
        if (a == null || seen.has(a.id)) return false // an id is a key: the first occurrence stands
        seen.add(a.id)
        return true
      })
      .toSorted(byUrgency)

  const projects: Project[] = []
  for (const repo of fleet.repos) {
    const agents = agentsOf(repo.sessions)
    if (agents.length === 0) continue
    const branch = cleanLine(repo.git?.branch)
    const commit = repo.git?.lastCommit
    projects.push({
      name: cleanLine(repo.name) ?? '',
      cwd: cleanLine(repo.space) ?? '',
      // The factory has no upstream counts: ahead and behind are 0 (Argo requires numbers), and the model is not told them.
      git:
        repo.git && branch
          ? {
              branch,
              dirty: repo.git.dirty,
              ahead: 0,
              behind: 0,
              lastCommit: commit
                ? { sha: cleanLine(commit.sha) ?? '', subject: cleanLine(commit.subject) ?? '', at: commit.at }
                : null,
            }
          : null,
      agents,
    })
  }
  const unplaced = agentsOf(fleet.unplaced)
  if (unplaced.length > 0) projects.push({ name: UNPLACED_PROJECT, cwd: '', git: null, agents: unplaced })

  const rank = (p: Project) => Math.min(...p.agents.map((a) => STATE_RANK[a.state]))
  projects.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name))

  const humanQueue: HumanQueueEntry[] = fleet.asks
    .filter((ask) => ask.kind === 'human')
    .toSorted((x, y) => (epochMs(y.at) ?? 0) - (epochMs(x.at) ?? 0))
    .map((ask) => ({
      id: cleanLine(ask.id) ?? '',
      askedAt: cleanLine(ask.at) || null,
      question: clean(ask.text) ?? '',
      cmd: null,
    }))

  return {
    generatedAt: now,
    staleAfterHours: options.staleAfterHours,
    summary: summarize(projects),
    projects,
    humanQueue,
    warnings: [...(options.warnings ?? []), ...fleet.errors.map((e) => cleanLine(e) ?? '')],
  }
}

/** The snapshot of a factory that could not be read: no projects, the cause as the one warning. */
export function emptySnapshot(options: { now: number; staleAfterHours: number; warning: string }): Snapshot {
  return {
    generatedAt: options.now,
    staleAfterHours: options.staleAfterHours,
    summary: { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0 },
    projects: [],
    humanQueue: [],
    warnings: [options.warning],
  }
}
