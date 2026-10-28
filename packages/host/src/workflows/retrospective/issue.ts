import { createHash } from 'node:crypto'
import type { TrackedPaths } from './tracked.ts'
import type { RetroAnalysis } from './schema.ts'

// The repo is public and runs review private and work repositories. An issue is built from structured fields only:
// the proposal's kind, a target that is a tracked path of this repo, its confidence, evidence run ids, and a pointer to
// the private journal. The model's free text (change, title, facts) never reaches an issue, so it cannot leak what it
// quoted; there is no text filter to get around.

type Proposal = RetroAnalysis['proposals'][number]

const normalize = (text: string) => text.toLowerCase().replaceAll(/\s+/g, ' ').trim()

/** The path an issue names for a proposal's target: an agent name stands for its definition directory. */
export const targetPath = (target: string, agents: readonly string[]) =>
  agents.includes(target) ? `agents/${target}` : target

/** Stable across weeks: the same kind, target and (normalised) change is the same proposal. 16 hex characters. */
export function proposalHash(proposal: Pick<Proposal, 'kind' | 'change'>, path: string): string {
  return createHash('sha256')
    .update(`${proposal.kind}\n${path}\n${normalize(proposal.change)}`)
    .digest('hex')
    .slice(0, 16)
}

export const markerFor = (hash: string) => `<!-- agw-retro:${hash} -->`

export interface IssueDraft {
  title: string
  body: string
  hash: string
}

export type IssueDecision = ({ ok: true } & IssueDraft) | { ok: false; hash: string; reason: string }

const fenced = (value: string) => `\`${value.replaceAll('`', "'")}\``

export function issueFor(args: {
  workflow: string
  retroRunId: string
  proposal: Proposal
  agents: readonly string[]
  tracked: TrackedPaths
}): IssueDecision {
  const { workflow, retroRunId, proposal, agents, tracked } = args
  const path = targetPath(proposal.target, agents)
  const hash = proposalHash(proposal, path)
  if (!tracked.has(path)) return { ok: false, hash, reason: 'target is not a tracked path of this repository' }
  const title = `retro(${workflow}): ${proposal.kind} change for ${path} [${hash.slice(0, 8)}]`
  const body = [
    markerFor(hash),
    `Proposed by the weekly retrospective of ${fenced(workflow)}. Proposals are never applied automatically.`,
    '',
    `- **Kind:** ${proposal.kind}`,
    `- **Target:** ${fenced(path)}`,
    `- **Confidence:** ${proposal.confidence}`,
    `- **Evidence (run ids):** ${proposal.evidence.map(fenced).join(', ')}`,
    '',
    `Details are private: \`agw run status ${retroRunId}\` shows the proposal text in the retrospective run's output.`,
  ].join('\n')
  return { ok: true, title, body, hash }
}
