import type {
  ChatPort,
  ChatRequest,
  ChatResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  IuTransports,
  Tokens,
} from '../transports/port.ts'

type Reply<Req, Res> = Res | Error | ((request: Req) => Res | Error)

/** `tokens` and `cost` are what the fake reports through `onUsage`; `tokens: null` reports nothing. */
type ChatReply = Partial<ChatResult> & { tokens?: Tokens | null; cost?: number | null }
type DecisionReply = DecisionResult & { tokens?: { input: number; output: number } | null }

export interface FakeTransports extends IuTransports {
  chatCalls: { wire: 'openai' | 'anthropic'; request: ChatRequest }[]
  decisionCalls: DecisionRequest[]
}

const DEFAULT_TOKENS = { input: 10, output: 5, cacheRead: 0, reasoning: 0 }

/** In-memory adapters for tests that are not about the wire. Replies are consumed in order, the last one repeats. */
export function fakeTransports(script: {
  openai?: Reply<ChatRequest, ChatReply>[]
  anthropic?: Reply<ChatRequest, ChatReply>[]
  decision?: Reply<DecisionRequest, DecisionReply>[]
}): FakeTransports {
  const chatCalls: FakeTransports['chatCalls'] = []
  const decisionCalls: DecisionRequest[] = []
  const next = <Req, Res>(replies: Reply<Req, Res>[] | undefined, name: string, request: Req, index: number) => {
    const reply = replies?.[Math.min(index, replies.length - 1)]
    if (reply === undefined) throw new Error(`fake transport: no reply scripted for ${name}`)
    const value = typeof reply === 'function' ? (reply as (r: Req) => Res | Error)(request) : reply
    if (value instanceof Error) throw value
    return value
  }
  const chat = (wire: 'openai' | 'anthropic'): ChatPort => ({
    async complete(request, _signal, onUsage) {
      const index = chatCalls.filter((c) => c.wire === wire).length
      chatCalls.push({ wire, request })
      const { tokens, cost, ...reply } = next(script[wire], wire, request, index)
      const model = reply.model ?? request.model
      if (tokens !== null) onUsage?.({ model, tokens: tokens ?? DEFAULT_TOKENS, cost: cost ?? null })
      return { text: '', stop: 'complete', ...reply, model }
    },
  })
  const decision: DecisionPort = {
    async decide(request, _signal, onUsage) {
      decisionCalls.push(request)
      const { tokens, ...reply } = next(script.decision, 'decision', request, decisionCalls.length - 1)
      if (tokens !== null) {
        const t = tokens ?? { input: 10, output: 2 }
        onUsage?.({ model: reply.model, tokens: { ...t, cacheRead: 0, reasoning: 0 }, cost: null })
      }
      return reply
    },
  }
  return { openai: chat('openai'), anthropic: chat('anthropic'), decision, chatCalls, decisionCalls }
}
