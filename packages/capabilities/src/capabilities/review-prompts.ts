import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cap on the diff a single-call review capability sends inline; the rest is marked as cut. */
export const MAX_DIFF_CHARS = 200_000

const AGENTS_DIR = fileURLToPath(new URL('../../../../agents/', import.meta.url))
const cache = new Map<string, string>()

/**
 * The prompt of a review capability: `agents/review-<name>/AGENTS.md`. The two single-call seats (router, adversary)
 * keep their prompts there beside the agents, so the run fingerprint hashes them like any agent definition.
 */
export function reviewPrompt(name: 'router' | 'adversary'): string {
  let text = cache.get(name)
  if (text === undefined) {
    text = readFileSync(`${AGENTS_DIR}review-${name}/AGENTS.md`, 'utf8')
    cache.set(name, text)
  }
  return text
}

export function capDiff(diff: string): { text: string; truncatedChars: number } {
  if (diff.length <= MAX_DIFF_CHARS) return { text: diff, truncatedChars: 0 }
  return {
    text: `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`,
    truncatedChars: diff.length - MAX_DIFF_CHARS,
  }
}

/**
 * Untrusted text between markers that carry a token no text composed before it could know. The token is a hash of the
 * body, not a random value, so the same diff always renders the same prompt (a replayed step re-sends what it sent).
 */
export function dataBlock(label: string, body: string): string {
  const nonce = createHash('sha256').update(body).digest('hex').slice(0, 12)
  return `\n\n<<<${label}_${nonce}_BEGIN>>>\n${body.trim()}\n<<<${label}_${nonce}_END>>>\n`
}
