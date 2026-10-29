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
import { relativeAge, truncate } from './text.ts'

const MAX_LAST_PROMPT_CHARS = 600
const MAX_LAST_REPLY_CHARS = 800

/** Every project and agent of the snapshot as plain-text facts for the classify seat. Pure. */
export function buildAgentFacts(snapshot: Pick<Snapshot, 'generatedAt' | 'projects'>): string {
  const { generatedAt, projects } = snapshot
  const lines: string[] = []
  for (const project of projects) {
    lines.push(`## Project: ${project.name}`)
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

    for (const agent of project.agents) {
      lines.push(`- agent id: ${agent.id}`)
      lines.push(`  source: ${agent.source}  state: ${agent.state}`)
      if (agent.title) lines.push(`  title: ${agent.title}`)
      if (agent.herdrStatus) lines.push(`  herdrStatus: ${agent.herdrStatus}`)
      if (agent.claudeStatus) lines.push(`  claudeStatus: ${agent.claudeStatus}`)
      if (agent.waitingFor) lines.push(`  waitingFor: ${agent.waitingFor}`)
      // The derived state collapses a job's status to working / done / unknown: spelled out for the model.
      if (agent.tier) lines.push(`  dispatch tier: ${agent.tier}  job activity: ${agent.state}`)
      if (agent.lastPrompt) lines.push(`  lastPrompt: ${truncate(agent.lastPrompt, MAX_LAST_PROMPT_CHARS)}`)
      if (agent.lastReply) lines.push(`  lastReply: ${truncate(agent.lastReply, MAX_LAST_REPLY_CHARS)}`)
      lines.push(`  lastActivity: ${relativeAge(agent.lastActivityAt, generatedAt)} ago`)
    }
  }
  return lines.join('\n')
}

/** Every agent id of the snapshot, in order. */
export const agentIds = (snapshot: Pick<Snapshot, 'projects'>): string[] =>
  snapshot.projects.flatMap((p) => p.agents.map((a) => a.id))

/**
 * Merges the seat's verdicts onto the snapshot's own agent ids, never the reverse. An id the seat returned that the
 * snapshot does not have is dropped; one the seat omitted becomes the safe default (`watch`, null, `low`, `synthesized`).
 */
export function reconcileOverview(
  snapshot: Snapshot,
  verdicts: Pick<OverviewAgent, 'id' | 'recommendation' | 'standing' | 'blocker' | 'confidence'>[],
  model: string,
  generatedAt: number,
): OverviewOutput {
  const known = new Map<string, { sessionId: string | null; project: string }>()
  for (const project of snapshot.projects) {
    for (const agent of project.agents) known.set(agent.id, { sessionId: agent.sessionId, project: project.name })
  }
  const seen = new Set<string>()
  const agents: OverviewAgent[] = []
  for (const v of verdicts) {
    const meta = known.get(v.id)
    if (!meta || seen.has(v.id)) continue
    seen.add(v.id)
    agents.push({ ...v, sessionId: meta.sessionId, project: meta.project })
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
  return { generatedAt, model, snapshotGeneratedAt: snapshot.generatedAt, agents }
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
