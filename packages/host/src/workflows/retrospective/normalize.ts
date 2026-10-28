import { containsFence, MAX_FACT_CHARS } from '../../learnings/index.ts'
import type { RetroAnalysis } from './schema.ts'

const RUN_ID = /^[\w-]{8,64}$/

/** Shape only: whether the target is a tracked path is decided when an issue is built, so a proposal with an invented path still reaches the run output. */
export function targetProblem(target: string, agents: readonly string[]): string | null {
  if (agents.includes(target)) return null
  if (/^agw [a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*){0,3}$/.test(target)) return null
  const parts = target.split('/')
  if (
    target.startsWith('/') ||
    target.startsWith('~') ||
    target.includes('\\') ||
    parts.includes('..') ||
    parts.includes('')
  ) {
    return 'target is not a repo-relative path'
  }
  return /^[\w./@+-]+$/.test(target) ? null : 'target is not a repo-relative path'
}

export interface Checked {
  proposals: RetroAnalysis['proposals']
  learnings: RetroAnalysis['learnings']
  dropped: string[]
}

/**
 * Checks the agent's answer against what is known: evidence must be run ids that were in the sample, a learning must
 * name an agent the workflow runs, a target must sit inside this repo. Anything else is dropped with its reason, never
 * repaired. Duplicates inside one answer collapse to the first.
 */
export function checkAnalysis(args: {
  analysis: RetroAnalysis
  sampled: ReadonlySet<string>
  agents: readonly string[]
}): Checked {
  const { analysis, sampled, agents } = args
  const dropped: string[] = []
  const evidenceOf = (ids: string[]) => [...new Set(ids.filter((id) => RUN_ID.test(id) && sampled.has(id)))]

  const proposals: Checked['proposals'] = []
  const titles = new Set<string>()
  for (const p of analysis.proposals) {
    const evidence = evidenceOf(p.evidence)
    const label = `proposal "${p.title.slice(0, 60)}"`
    const problem = targetProblem(p.target, agents)
    if (problem) dropped.push(`${label}: ${problem}`)
    else if (evidence.length === 0) dropped.push(`${label}: no evidence from the sample`)
    else if (titles.has(p.title.trim().toLowerCase())) dropped.push(`${label}: duplicate title`)
    else {
      titles.add(p.title.trim().toLowerCase())
      proposals.push({ ...p, evidence })
    }
  }

  const learnings: Checked['learnings'] = []
  const facts = new Set<string>()
  for (const l of analysis.learnings) {
    const fact = l.fact.replaceAll(/\s+/g, ' ').trim()
    const evidence = evidenceOf(l.evidence)
    const label = `learning for ${l.agent}`
    if (!agents.includes(l.agent)) dropped.push(`${label}: the workflow does not run this agent`)
    else if (fact === '' || fact.length > MAX_FACT_CHARS)
      dropped.push(`${label}: fact is empty or over ${MAX_FACT_CHARS} characters`)
    else if (containsFence(fact)) dropped.push(`${label}: fact contains the learned_facts fence`)
    else if (evidence.length === 0) dropped.push(`${label}: no evidence from the sample`)
    else if (facts.has(`${l.agent}\n${fact}`)) dropped.push(`${label}: duplicate fact`)
    else {
      facts.add(`${l.agent}\n${fact}`)
      learnings.push({ agent: l.agent, fact, evidence })
    }
  }
  return { proposals, learnings, dropped }
}
