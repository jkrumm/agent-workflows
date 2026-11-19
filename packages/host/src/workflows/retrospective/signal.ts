import { createHash } from 'node:crypto'
import type { TrackedPaths } from './tracked.ts'
import type { RetroAnalysis } from './schema.ts'

// The repo is public and runs review private and work repositories. A signal is built from structured fields only: the
// proposal's kind, a target that is a tracked path of this repo, its confidence, evidence run ids, and a pointer to the
// private journal. The model's free text (change, title, facts) never reaches a signal, so it cannot leak what it
// quoted; there is no text filter to get around. The factory turns a signal into an Issue, whose lead reads the text in
// the retrospective run's output.

type Proposal = RetroAnalysis['proposals'][number]

/** Signals one retrospective run files at most: a noisy week cannot flood the queue. The best-evidenced go first. */
export const MAX_SIGNALS_PER_RUN = 3

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 } as const

const normalize = (text: string) => text.toLowerCase().replaceAll(/\s+/g, ' ').trim()

/** The path a signal names for a proposal's target: an agent name stands for its definition directory. */
const targetPath = (target: string, agents: readonly string[]) =>
  agents.includes(target) ? `agents/${target}` : target

/** Stable across weeks: the same kind, target and (normalised) change is the same proposal. 16 hex characters. */
export function proposalHash(proposal: Pick<Proposal, 'kind' | 'change'>, path: string): string {
  return createHash('sha256')
    .update(`${proposal.kind}\n${path}\n${normalize(proposal.change)}`)
    .digest('hex')
    .slice(0, 16)
}

/** In the signal text, so the factory's triage can tell a proposal made again next week from a new one. */
export const markerFor = (hash: string) => `agw-retro:${hash}`

export interface SignalDraft {
  title: string
  text: string
  hash: string
}

export type SignalDecision = ({ ok: true } & SignalDraft) | { ok: false; hash: string; reason: string }

const fenced = (value: string) => `\`${value.replaceAll('`', "'")}\``

export function signalFor(args: {
  workflow: string
  retroRunId: string
  sampled: number
  windowDays: number
  proposal: Proposal
  agents: readonly string[]
  tracked: TrackedPaths
}): SignalDecision {
  const { workflow, retroRunId, sampled, windowDays, proposal, agents, tracked } = args
  const path = targetPath(proposal.target, agents)
  const hash = proposalHash(proposal, path)
  if (!tracked.has(path)) return { ok: false, hash, reason: 'target is not a tracked path of this repository' }
  const title = `retro(${workflow}): ${proposal.kind} change for ${path} [${hash.slice(0, 8)}]`
  const text = [
    `Proposed by the weekly retrospective of ${fenced(workflow)} (${sampled} runs sampled over ${windowDays} days). Proposals are never applied automatically.`,
    '',
    `- Kind: ${proposal.kind}`,
    `- Target: ${fenced(path)}`,
    `- Confidence: ${proposal.confidence}`,
    `- Evidence: ${proposal.evidence.length} of ${sampled} sampled runs: ${proposal.evidence.map(fenced).join(', ')}`,
    `- Marker: ${markerFor(hash)}`,
    '',
    `The proposal text is private: \`agw run status ${retroRunId}\` shows it in the retrospective run's output.`,
  ].join('\n')
  return { ok: true, title, text, hash }
}

/** The best-evidenced first: more cited runs, then higher confidence, then the order the agent gave. */
export function rankProposals<T extends Pick<Proposal, 'evidence' | 'confidence'>>(proposals: readonly T[]): T[] {
  return proposals
    .map((proposal, index) => ({ proposal, index }))
    .sort(
      (a, b) =>
        b.proposal.evidence.length - a.proposal.evidence.length ||
        CONFIDENCE_RANK[b.proposal.confidence] - CONFIDENCE_RANK[a.proposal.confidence] ||
        a.index - b.index,
    )
    .map((entry) => entry.proposal)
}
