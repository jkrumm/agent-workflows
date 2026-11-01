import { createHash } from 'node:crypto'

const SESSION_HEADERS = ['x-agw-session', 'x-claude-code-session-id', 'x-session-affinity'] as const
const CLAUDE_CODE_SYSTEM_PREFIX = 'You are Claude Code'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * The session a request belongs to: the first non-empty of `x-agw-session`, `x-claude-code-session-id`,
 * `x-session-affinity`, body `metadata.user_id`, else the first 32 hex chars of the sha256 of the first user message's
 * `content` (JSON-serialised). Null when none applies.
 */
export function sessionId(headers: Headers, body: unknown): string | null {
  for (const name of SESSION_HEADERS) {
    const value = nonEmpty(headers.get(name))
    if (value !== null) return value
  }
  if (!isRecord(body)) return null

  const userId = isRecord(body.metadata) ? nonEmpty(body.metadata.user_id) : null
  if (userId !== null) return userId

  if (!Array.isArray(body.messages)) return null
  const first: unknown = body.messages.find((message: unknown) => isRecord(message) && message.role === 'user')
  if (!isRecord(first) || first.content === undefined || first.content === null) return null
  return createHash('sha256').update(JSON.stringify(first.content)).digest('hex').slice(0, 32)
}

function systemTexts(body: unknown): string[] {
  if (!isRecord(body)) return []
  if (typeof body.system === 'string') return [body.system]
  if (!Array.isArray(body.system)) return []
  return body.system.flatMap((block: unknown) =>
    isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
  )
}

/**
 * True when a request carries any Claude Code signal (a funded credit org refuses those with the balance 400): an
 * `anthropic-beta` token starting `claude-code-`, any system block starting `You are Claude Code`, a `user-agent`
 * starting `claude-cli/`, or `x-app: cli`. Read-only; the body is never edited.
 */
export function isClaudeCodeShaped(headers: Headers, body: unknown): boolean {
  const betas = headers.get('anthropic-beta')?.split(',') ?? []
  if (betas.some((token) => token.trim().toLowerCase().startsWith('claude-code-'))) return true
  if (headers.get('user-agent')?.trim().toLowerCase().startsWith('claude-cli/')) return true
  if (headers.get('x-app')?.trim().toLowerCase() === 'cli') return true
  return systemTexts(body).some((text) => text.trimStart().startsWith(CLAUDE_CODE_SYSTEM_PREFIX))
}
