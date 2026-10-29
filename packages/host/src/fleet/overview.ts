import type { AgentEnrichment } from './render.ts'
import {
  type Agent,
  type EnrichedAgent,
  OVERVIEW_OUTPUT,
  type OverviewAgent,
  type OverviewOutput,
  type OverviewPayload,
  type Project,
  type Snapshot,
} from './schema.ts'
import { clean } from './derive.ts'
import { relativeAge, truncate } from './text.ts'

const MAX_LAST_PROMPT_CHARS = 600
const MAX_LAST_REPLY_CHARS = 800

function projectLines(project: Project, generatedAt: number): string[] {
  const lines: string[] = [`## Project: ${project.name}`]
  if (project.git) {
    const { branch, dirty, ahead, behind, lastCommit } = project.git
    lines.push(
      `branch: ${branch}${dirty ? ' (dirty — uncommitted changes)' : ' (clean)'}  ahead: ${ahead}  behind: ${behind}`,
    )
    lines.push(
      lastCommit
        ? `last commit: "${truncate(lastCommit.subject, 120)}" (${relativeAge(Date.parse(lastCommit.at), generatedAt)} ago)`
        : 'last commit: none',
    )
  } else {
    lines.push('branch: unknown (not a git repo, or git status failed)')
  }
  return lines
}

function agentLines(agent: Agent, generatedAt: number): string[] {
  const lines = [`- agent id: ${agent.id}`, `  source: ${agent.source}  state: ${agent.state}`]
  if (agent.title) lines.push(`  title: ${agent.title}`)
  if (agent.herdrStatus) lines.push(`  herdrStatus: ${agent.herdrStatus}`)
  if (agent.claudeStatus) lines.push(`  claudeStatus: ${agent.claudeStatus}`)
  if (agent.waitingFor) lines.push(`  waitingFor: ${agent.waitingFor}`)
  // The derived state collapses a job's status to working / done / unknown: spelled out for the model.
  if (agent.tier) lines.push(`  dispatch tier: ${agent.tier}  job activity: ${agent.state}`)
  if (agent.lastPrompt) lines.push(`  lastPrompt: ${truncate(agent.lastPrompt, MAX_LAST_PROMPT_CHARS)}`)
  if (agent.lastReply) lines.push(`  lastReply: ${truncate(agent.lastReply, MAX_LAST_REPLY_CHARS)}`)
  lines.push(`  lastActivity: ${relativeAge(agent.lastActivityAt, generatedAt)} ago`)
  return lines
}

/** Every project and agent of the snapshot as plain-text facts for the classify seat. Pure. */
export function buildAgentFacts(snapshot: Pick<Snapshot, 'generatedAt' | 'projects'>): string {
  const { generatedAt, projects } = snapshot
  return projects
    .flatMap((project) => [
      ...projectLines(project, generatedAt),
      ...project.agents.flatMap((a) => agentLines(a, generatedAt)),
    ])
    .join('\n')
}

/** What the classify step needs of a snapshot, and all the run journals of it: the facts text and the ids to answer. */
export type ClassifyInput = {
  /** Epoch ms of the snapshot. */
  generatedAt: number
  facts: string
  /** The agents the facts list: the answer is asked for exactly these. */
  agentIds: string[]
  /** Every agent of the snapshot, for the merge: the ones left out of the facts become placeholders. */
  known: { id: string; sessionId: string | null; project: string }[]
}

/**
 * The facts for the seat within its input cap: the most recently active agents first, whole agents only, so an
 * oversized fleet is classified in part (the rest are `synthesized` placeholders) and never fails the step.
 */
export function classifyInput(
  snapshot: Pick<Snapshot, 'generatedAt' | 'projects'>,
  limits: { maxChars: number; maxAgents: number },
): ClassifyInput {
  const { generatedAt, projects } = snapshot
  const known = projects.flatMap((p) => p.agents.map((a) => ({ id: a.id, sessionId: a.sessionId, project: p.name })))
  const byActivity = projects
    .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
    .toSorted((x, y) => (y.agent.lastActivityAt ?? 0) - (x.agent.lastActivityAt ?? 0))

  const kept = new Set<string>()
  const opened = new Set<Project>()
  let chars = 0
  for (const { project, agent } of byActivity) {
    if (kept.size >= limits.maxAgents) break
    const header = opened.has(project) ? 0 : projectLines(project, generatedAt).join('\n').length + 1
    const size = header + agentLines(agent, generatedAt).join('\n').length + 1
    if (chars + size > limits.maxChars) continue // a smaller agent further down may still fit
    chars += size
    kept.add(agent.id)
    opened.add(project)
  }
  const trimmed = projects
    .map((project) => ({ ...project, agents: project.agents.filter((a) => kept.has(a.id)) }))
    .filter((project) => project.agents.length > 0)
  return { generatedAt, facts: buildAgentFacts({ generatedAt, projects: trimmed }), agentIds: [...kept], known }
}

/**
 * Merges the seat's verdicts onto the snapshot's own agent ids, never the reverse. An id the seat returned that the
 * snapshot does not have is dropped; one the seat omitted becomes the safe default (`watch`, null, `low`, `synthesized`).
 * The model's words pass `clean` like every other text from outside.
 */
export function reconcileOverview(
  snapshot: { generatedAt: number; projects: { name: string; agents: { id: string; sessionId: string | null }[] }[] },
  verdicts: Pick<OverviewAgent, 'id' | 'recommendation' | 'standing' | 'blocker' | 'confidence'>[],
  model: string,
  generatedAt: number,
): OverviewOutput {
  const known = new Map<string, { sessionId: string | null; project: string }>()
  for (const project of snapshot.projects) {
    for (const agent of project.agents) known.set(agent.id, { sessionId: agent.sessionId, project: project.name })
  }
  return reconcileKnown(snapshot.generatedAt, known, verdicts, model, generatedAt)
}

/** {@link reconcileOverview} on the `known` list a {@link ClassifyInput} carries. */
export function reconcileKnown(
  snapshotGeneratedAt: number,
  known: ReadonlyMap<string, { sessionId: string | null; project: string }>,
  verdicts: Pick<OverviewAgent, 'id' | 'recommendation' | 'standing' | 'blocker' | 'confidence'>[],
  model: string,
  generatedAt: number,
): OverviewOutput {
  const seen = new Set<string>()
  const agents: OverviewAgent[] = []
  for (const v of verdicts) {
    const meta = known.get(v.id)
    if (!meta || seen.has(v.id)) continue
    seen.add(v.id)
    agents.push({
      ...v,
      standing: clean(v.standing),
      blocker: clean(v.blocker),
      sessionId: meta.sessionId,
      project: meta.project,
    })
  }
  for (const [id, meta] of known) {
    if (seen.has(id)) continue
    agents.push({
      id,
      sessionId: meta.sessionId,
      project: meta.project,
      recommendation: 'watch',
      standing: null,
      blocker: null,
      confidence: 'low',
      synthesized: true,
    })
  }
  return { generatedAt, model, snapshotGeneratedAt, agents }
}

export type MergedOverview = Pick<OverviewPayload, 'projects' | 'overview'>

/**
 * The newest completed run's verdicts on a fresh snapshot, by agent id. No run yet (`cached: null`): every agent with
 * null fields and `overview: null`. An agent active more recently than the run is nulled and marked
 * `recommendationStale`: it did something after the model looked.
 */
export function mergeOverviewIntoSnapshot(snapshot: Snapshot, cached: OverviewOutput | null): MergedOverview {
  const overview = cached
    ? {
        generatedAt: cached.generatedAt,
        model: cached.model,
        ageMs: Math.max(0, snapshot.generatedAt - cached.generatedAt),
      }
    : null
  const byId = new Map((cached?.agents ?? []).map((a) => [a.id, a]))
  const blank = { recommendation: null, standing: null, blocker: null, confidence: null }

  const projects = snapshot.projects.map((project: Project) => ({
    ...project,
    agents: project.agents.map((agent: Agent): EnrichedAgent => {
      const verdict = cached ? byId.get(agent.id) : undefined
      if (!verdict || !cached) return { ...agent, ...blank }
      if (agent.lastActivityAt != null && cached.generatedAt < agent.lastActivityAt) {
        return { ...agent, ...blank, recommendationStale: true }
      }
      return {
        ...agent,
        recommendation: verdict.recommendation,
        standing: verdict.standing,
        blocker: verdict.blocker,
        confidence: verdict.confidence,
      }
    }),
  }))
  return { projects, overview }
}

/** The stored run output read back through its own schema: drift degrades to "no overview yet", never an error. */
export function parseStoredOverview(raw: unknown): OverviewOutput | null {
  const parsed = OVERVIEW_OUTPUT.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The verdicts of a merged overview as the renderer's enrichment map. */
export function enrichmentOf(merged: Pick<MergedOverview, 'projects'>): Map<string, AgentEnrichment> {
  const map = new Map<string, AgentEnrichment>()
  for (const project of merged.projects) {
    for (const agent of project.agents) {
      if (agent.recommendation) map.set(agent.id, { recommendation: agent.recommendation, standing: agent.standing })
    }
  }
  return map
}
