import type {
  ChatPort,
  ChatRequest,
  ChatResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  IuTransports,
} from '../transports/port.ts'

type Reply<Req, Res> = Res | Error | ((request: Req) => Res | Error)

export interface FakeTransports extends IuTransports {
  chatCalls: { wire: 'openai' | 'anthropic'; request: ChatRequest }[]
  decisionCalls: DecisionRequest[]
}

const DEFAULT_TOKENS = { input: 10, output: 5, cacheRead: 0, reasoning: 0 }

/** In-memory adapters for tests that are not about the wire. Replies are consumed in order, the last one repeats. */
export function fakeTransports(script: {
  openai?: Reply<ChatRequest, Partial<ChatResult>>[]
  anthropic?: Reply<ChatRequest, Partial<ChatResult>>[]
  decision?: Reply<DecisionRequest, DecisionResult>[]
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
    async complete(request) {
      const index = chatCalls.filter((c) => c.wire === wire).length
      chatCalls.push({ wire, request })
      const reply = next(script[wire], wire, request, index)
      return { text: '', stop: 'complete', model: request.model, tokens: DEFAULT_TOKENS, cost: null, ...reply }
    },
  })
  const decision: DecisionPort = {
    async decide(request) {
      decisionCalls.push(request)
      return next(script.decision, 'decision', request, decisionCalls.length - 1)
    },
  }
  return { openai: chat('openai'), anthropic: chat('anthropic'), decision, chatCalls, decisionCalls }
}
