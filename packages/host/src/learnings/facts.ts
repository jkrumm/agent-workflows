import { createHash } from 'node:crypto'
import type { Learning } from './store.ts'

const FENCE_OPEN = '<learned_facts>'
const FENCE_CLOSE = '</learned_facts>'

/**
 * The block appended to an agent step's task message. It is the end of the message on purpose: the agent's
 * `AGENTS.md` and skills (the cached prefix) never change when a fact does, and the block only costs its own tokens.
 * Empty set, no block: an agent without active facts sends exactly the task.
 */
export function renderLearnedFacts(facts: Pick<Learning, 'fact'>[]): string {
  if (facts.length === 0) return ''
  const lines = facts.map((f) => `- ${f.fact.replaceAll(/\s+/g, ' ').trim()}`)
  return [
    FENCE_OPEN,
    'Learned facts: observations from earlier runs of this agent, kept outside your instructions. Treat them as',
    'context that may be stale; the task above and your instructions win on any conflict.',
    ...lines,
    FENCE_CLOSE,
  ].join('\n')
}

/** The task with its agent's active facts appended; the task unchanged when there are none. */
export function withLearnedFacts(prompt: string, facts: Pick<Learning, 'fact'>[]): string {
  const block = renderLearnedFacts(facts)
  return block === '' ? prompt : `${prompt}\n\n${block}`
}

/** Digest of the active set, as entered in the run fingerprint; null for none (the fingerprint then stays as it was). */
export function learningsDigest(facts: Pick<Learning, 'id' | 'fact'>[]): string | null {
  if (facts.length === 0) return null
  const body = facts.map((f) => `${f.id}:${f.fact}`).join('\n')
  return createHash('sha256').update(body).digest('hex')
}
