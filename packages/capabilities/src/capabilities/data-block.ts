import { createHash } from 'node:crypto'

/**
 * Untrusted text between markers that carry a token no text composed before it could know. The token is a hash of the
 * body, not a random value, so the same diff always renders the same prompt (a replayed step re-sends what it sent).
 */
export function dataBlock(label: string, body: string): string {
  const nonce = createHash('sha256').update(body).digest('hex').slice(0, 12)
  return `\n\n<<<${label}_${nonce}_BEGIN>>>\n${body.trim()}\n<<<${label}_${nonce}_END>>>\n`
}
