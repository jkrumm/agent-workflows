import type { Usage } from '@agent-workflows/runtime'

/**
 * The fields read from one entry of OpenCode's `GET /api/session/:id/message` page (`data[]`, v2). Lenient:
 * anything else on a message is ignored, and a message type other than `assistant` carries no usage.
 */
export type OpenCodeMessage = {
  type?: string
  /** Additive, as OpenCode stores it: `input` excludes cache reads and writes, `output` excludes reasoning. */
  tokens?: {
    input?: number | null
    output?: number | null
    reasoning?: number | null
    cache?: { read?: number | null; write?: number | null } | null
  } | null
  cost?: number | null
  content?: { type?: string }[] | null
  modelID?: string | null
  model?: string | { id?: string | null } | null
}

const n = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function modelOf(message: OpenCodeMessage): string | null {
  if (typeof message.model === 'string') return message.model
  return message.model?.id ?? message.modelID ?? null
}

/**
 * One agent step's usage from its session's messages: the source of truth for tokens, cost and tool calls
 * (S2: OpenCode emits no model or token spans). Converts OpenCode's additive counts to the runtime's raw provider
 * counts (`input` includes cache reads and writes, `output` includes reasoning, each also in its own bucket); the
 * usage projection subtracts them again.
 *
 * `cost` is the sum of the messages' reported cost, or null when any assistant message with tokens carries none:
 * the runtime then counts the step as unpriced instead of a silent undercount. `model` is the route's model when
 * the host knows it, else the first one a message names (v2 messages do not always carry it).
 */
export function usageFromOpenCodeMessages(
  messages: readonly OpenCodeMessage[],
  options: { model?: string } = {},
): Usage {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let cost = 0
  let priced = true
  let toolCalls = 0
  let model = options.model ?? null
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    toolCalls += (message.content ?? []).filter((block) => block.type === 'tool').length
    model ??= modelOf(message)
    const t = message.tokens
    if (!t) continue
    const cacheRead = n(t.cache?.read)
    const cacheWrite = n(t.cache?.write)
    const reasoning = n(t.reasoning)
    tokens.input += n(t.input) + cacheRead + cacheWrite
    tokens.output += n(t.output) + reasoning
    tokens.cacheRead += cacheRead
    tokens.cacheWrite += cacheWrite
    tokens.reasoning += reasoning
    if (typeof message.cost === 'number' && Number.isFinite(message.cost)) cost += message.cost
    else priced = false
  }
  return {
    ...(model ? { model } : {}),
    tokens,
    cost: priced ? cost : null,
    costSource: priced ? 'provider' : 'unknown',
    toolCalls,
  }
}
