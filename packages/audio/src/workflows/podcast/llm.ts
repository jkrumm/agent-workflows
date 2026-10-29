import { costFromUsage, fallbackRoute, type ResolvedRoute } from '../../../../routes/src/index.ts'
import type { StepScope, Usage } from '../../../../runtime/src/index.ts'
import { log } from './log.ts'
import { type PodcastRouteId, resolvePodcastRoute } from './routes.pending.ts'
import type { ToolCallRecord } from './types.ts'

// The writers' room's model calls. Every call goes through a `ModelPort` (production: `iu.ts`, tests: a fake), is
// priced against its route (`costFromUsage`: IU's `usage.cost` first, else the route's rate) and reported to the step's
// `addUsage`, so the run record carries every call. The port speaks wires; this module owns the stage semantics ported
// from audio-gateway: the empty/truncated-answer retry (`callPodcastLlm`, `callAndParse`) and the tool loop
// (`llm-tools.ts`).

/** Raw provider counts: `input` includes cache reads and writes, `output` includes reasoning. */
export interface WireUsage {
  model: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite?: number; reasoning: number }
  /** USD as the provider reported it (`usage.cost`); null when it did not. */
  cost: number | null
}
export type OnWireUsage = (usage: WireUsage) => void

/** One single-shot completion. `cacheablePrefix` and `jsonSchema` are honoured on the Anthropic wire only. */
export interface ChatCall {
  wire: ResolvedRoute['wire']
  model: string
  effort?: string
  system: string
  user: string
  maxTokens: number
  cacheablePrefix?: string
  jsonSchema?: Record<string, unknown>
}

export interface ChatReply {
  text: string
  /** `length`: the output ceiling cut the answer; `other`: a refusal, a pause, or no stop reason. */
  stop: 'complete' | 'length' | 'other'
  stopDetail?: string
}

/** A message as it round-trips through a tool loop: loose on purpose, so provider fields survive untouched. */
export interface WireMessage {
  role?: string
  content?: string | null
  tool_calls?: ToolCallRequest[]
  tool_call_id?: string
  [key: string]: unknown
}

export interface ToolCallRequest {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** One tool-loop round. `api: 'responses'` is IU's `/v1/responses`; `chat` is `/chat/completions`. */
export interface RoundCall {
  api: 'chat' | 'responses'
  model: string
  effort?: string
  messages: WireMessage[]
  tools: ToolSchema[]
  maxTokens: number
}

/** A round's reply normalised across both APIs; `raw` (responses only) is what goes back into the transcript. */
export interface RoundReply {
  message: WireMessage
  finishReason?: string
  raw?: WireMessage[]
}

/** The transport. Rejects with a `ModelError` on a failed call; reports every billed attempt to `onUsage`. */
export interface ModelPort {
  chat(call: ChatCall, signal: AbortSignal, onUsage: OnWireUsage): Promise<ChatReply>
  round(call: RoundCall, signal: AbortSignal, onUsage: OnWireUsage): Promise<RoundReply>
}

/** A failed model call. `balance`: the provider refused for account balance; the route's fallback answers it. */
export class ModelError extends Error {
  override name = 'ModelError'
  constructor(
    message: string,
    readonly balance = false,
  ) {
    super(message)
  }
}

/** IU serves function tools for the GPT-6.1 family only on `/v1/responses` (chat/completions 503s; probed 2026-10-26). */
export const usesResponsesApi = (model: string): boolean => /^gpt-6\.1/.test(model)

/** What a step spent on model calls: summed over priced calls, `unpriced` counts the rest. */
export interface Spend {
  usd: number
  unpriced: number
}

/**
 * The model calls of ONE step: bound to its `addUsage` and signal, summing what it spent. Created inside the step
 * body, so a retried or resumed step starts from zero and reports only its own calls.
 */
export class Llm {
  readonly spend: Spend = { usd: 0, unpriced: 0 }

  constructor(
    private readonly port: ModelPort,
    private readonly scope: Pick<StepScope, 'addUsage' | 'signal' | 'progress'>,
    private readonly resolve: (id: PodcastRouteId) => ResolvedRoute = resolvePodcastRoute,
  ) {}

  /** The step was cancelled, lost its lease or is shutting down: a best-effort stage rethrows instead of falling back. */
  get aborted(): boolean {
    return this.scope.signal.aborted
  }

  get signal(): AbortSignal {
    return this.scope.signal
  }

  /** Resets the step's idle timer (a tool waiting on a long research run). */
  progress() {
    this.scope.progress()
  }

  route(id: PodcastRouteId): ResolvedRoute {
    return this.resolve(id)
  }

  private report(route: ResolvedRoute, usage: WireUsage) {
    const cost = costFromUsage(
      route.wire,
      {
        cost: usage.cost,
        prompt_tokens: usage.tokens.input,
        completion_tokens: usage.tokens.output,
        cache_read_input_tokens: usage.tokens.cacheRead,
        cache_creation_input_tokens: usage.tokens.cacheWrite ?? 0,
      },
      route.rate,
    )
    const priced: Usage = { model: usage.model, tokens: usage.tokens, cost: cost.usd, costSource: cost.source }
    if (cost.usd === null) this.spend.unpriced++
    else this.spend.usd += cost.usd
    this.scope.addUsage(priced)
    this.scope.progress()
  }

  /**
   * Runs `call` on the route; a provider-balance failure moves it once to the route's fallback (concept v3.3). A call
   * that came back without usage is still reported, unpriced, under the model it ran on.
   */
  private async onRoute<T>(id: PodcastRouteId, call: (route: ResolvedRoute, onUsage: OnWireUsage) => Promise<T>) {
    const primary = this.route(id)
    const attempt = async (route: ResolvedRoute) => {
      let reported = 0
      try {
        return await call(route, (usage) => {
          reported++
          this.report(route, usage)
        })
      } finally {
        if (reported === 0 && !this.scope.signal.aborted) {
          this.report(route, {
            model: route.model,
            tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
            cost: null,
          })
        }
      }
    }
    try {
      return await attempt(primary)
    } catch (error) {
      const fallback = fallbackRoute(primary)
      if (!fallback || !(error instanceof ModelError) || !error.balance) throw error
      log.warn('podcast provider balance exhausted; falling back', { route: id, to: fallback.model })
      return attempt(fallback)
    }
  }

  /**
   * One podcast completion (legacy `callPodcastLlm`). Returns "" for an answer the caller must retry with a larger
   * budget: an empty one, any incomplete stop on the Anthropic wire (a half-written segment must never be parsed
   * leniently), and a `length` stop when `retryOnTruncation` is set.
   */
  async call(params: {
    route: PodcastRouteId
    systemPrompt: string
    userContent: string
    maxCompletionTokens: number
    stage: string
    retryOnTruncation?: boolean
    cacheableSystemPrefix?: string
    jsonSchema?: Record<string, unknown>
  }): Promise<string> {
    const reply = await this.onRoute(params.route, (route, onUsage) =>
      this.port.chat(
        {
          wire: route.wire,
          model: route.model,
          ...(route.effort && route.effort !== 'none' ? { effort: route.effort } : {}),
          system: params.systemPrompt,
          user: params.userContent,
          maxTokens: params.maxCompletionTokens,
          ...(params.cacheableSystemPrefix ? { cacheablePrefix: params.cacheableSystemPrefix } : {}),
          ...(params.jsonSchema ? { jsonSchema: params.jsonSchema } : {}),
        },
        this.scope.signal,
        onUsage,
      ),
    )
    if (!reply.text.trim()) {
      log.warn('podcast writer returned no content', { stage: params.stage, stop: reply.stopDetail ?? reply.stop })
      return ''
    }
    const anthropic = this.route(params.route).wire === 'iu-anthropic'
    if (reply.stop !== 'complete' && (anthropic || (params.retryOnTruncation && reply.stop === 'length'))) {
      log.warn('podcast writer did not finish, forcing retry', {
        stage: params.stage,
        stop: reply.stopDetail ?? reply.stop,
      })
      return ''
    }
    return reply.text
  }

  /** One tool-loop round on the route, IU's OpenAI dialect (chat, or responses for the GPT-6.1 family). */
  round(id: PodcastRouteId, messages: WireMessage[], tools: ToolSchema[], maxTokens: number): Promise<RoundReply> {
    return this.onRoute(id, (route, onUsage) =>
      this.port.round(
        {
          api: usesResponsesApi(route.model) ? 'responses' : 'chat',
          model: route.model,
          ...(route.effort && route.effort !== 'none' ? { effort: route.effort } : {}),
          messages,
          tools,
          maxTokens,
        },
        this.scope.signal,
        onUsage,
      ),
    )
  }
}

/**
 * Call the writer and parse its reply, retrying the WHOLE call once when it does not parse (a non-deterministic model
 * occasionally returns malformed JSON; a second attempt is far cheaper than failing the run). `attempt` sizes the
 * budget. On the final failure the raw reply is logged.
 */
export async function callAndParse<T>(
  stage: string,
  call: (attempt: number) => Promise<string>,
  parse: (raw: string) => T,
  attempts = 2,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = await call(attempt)
    try {
      return parse(raw)
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (attempt < attempts) {
        log.warn('podcast writer reply did not parse, retrying', { stage, attempt, chars: raw.length, error: message })
        continue
      }
      log.error('podcast writer reply did not parse', { stage, attempt, chars: raw.length, error: message })
    }
  }
  throw lastError
}

/**
 * Output budget for a writer call: reasoning is invisible but counted against the ceiling, so budgets are sized for
 * reasoning plus text, and a retry gets double.
 */
export function writerBudget(visibleTokens: number, attempt: number): number {
  const reasoningHeadroom = 16000
  return Math.min(64000, (visibleTokens + reasoningHeadroom) * attempt)
}

// ---------------------------------------------------------------------------
// Tool loop (legacy llm-tools.ts)
// ---------------------------------------------------------------------------

export interface ToolDef<A = unknown> {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
  /** The result as a string the model reads. A throw becomes an error string; the loop keeps going. */
  execute: (args: A) => Promise<string>
}

export interface ToolLoopParams {
  route: PodcastRouteId
  systemPrompt: string
  userContent: string
  tools: ToolDef[]
  maxCompletionTokens: number
  stage: string
  /** Checked after each round's tool results are in; true ends the loop at once (a submit tool delivered the work). */
  shouldStop?: () => boolean
}

export interface ToolLoopResult {
  content: string
  calls: ToolCallRecord[]
  rounds: number
}

async function runTool(tool: ToolDef, call: ToolCallRequest): Promise<{ content: string; record: ToolCallRecord }> {
  let args: unknown
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: `error: invalid arguments JSON for tool "${tool.name}": ${message}`,
      record: { tool: tool.name, args: call.function.arguments, ok: false, ms: 0 },
    }
  }
  const start = Date.now()
  try {
    const content = await tool.execute(args)
    return { content, record: { tool: tool.name, args, ok: true, ms: Date.now() - start } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `error: ${message}`, record: { tool: tool.name, args, ok: false, ms: Date.now() - start } }
  }
}

const hasToolCalls = (reply: RoundReply) => Boolean(reply.message.tool_calls && reply.message.tool_calls.length > 0)

/**
 * One round, repeated once with a doubled budget when it was cut for budget reasons: a terminal reply with empty
 * content, or ANY round whose `finish_reason` is `length` (a tool call can be cut mid-`arguments` too). Throws when the
 * retry is still empty with no tool call, instead of parsing "" downstream.
 */
async function roundWithRetry(llm: Llm, params: ToolLoopParams, messages: WireMessage[], round: number) {
  const schemas = params.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  const first = await llm.round(params.route, messages, schemas, params.maxCompletionTokens)
  if (first.finishReason !== 'length' && (hasToolCalls(first) || (first.message.content ?? '').trim())) return first
  log.warn('podcast tool loop round truncated or empty, retrying with doubled budget', {
    stage: params.stage,
    round,
    finishReason: first.finishReason ?? null,
  })
  const retried = await llm.round(params.route, messages, schemas, params.maxCompletionTokens * 2)
  if (hasToolCalls(retried) || (retried.message.content ?? '').trim()) return retried
  throw new Error(
    `Podcast ${params.stage} tool loop round ${round} returned empty content (finish_reason=${retried.finishReason ?? 'unknown'}) after retry with doubled budget`,
  )
}

/**
 * System + user message, then rounds of tool calls executed in order, until the model answers without one: no round
 * cap (rules/agent-limits.md). The assistant message is echoed back EXACTLY as received, never rebuilt from parsed
 * fields: a provider that carries state in opaque fields (Gemini's `thought_signature`, DeepSeek's reasoning) fails
 * the next request when it does not round-trip, and an edited history breaks the prompt cache. Tool results are
 * appended, the head is never rewritten. On `/v1/responses` the output items are echoed and results go back as
 * `function_call_output`.
 */
export async function runToolLoop(llm: Llm, params: ToolLoopParams): Promise<ToolLoopResult> {
  const toolsByName = new Map(params.tools.map((t) => [t.name, t] as const))
  const messages: WireMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userContent },
  ]
  const calls: ToolCallRecord[] = []
  for (let round = 1; ; round++) {
    const { message, raw } = await roundWithRetry(llm, params, messages, round)
    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length === 0) return { content: message.content ?? '', calls, rounds: round }
    if (raw) messages.push(...raw)
    else messages.push(message)
    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name)
      const result = tool
        ? await runTool(tool, call)
        : {
            content: `error: unknown tool "${call.function.name}"`,
            record: { tool: call.function.name, args: call.function.arguments, ok: false, ms: 0 },
          }
      calls.push(result.record)
      messages.push(
        raw
          ? { type: 'function_call_output', call_id: call.id, output: result.content }
          : { role: 'tool', tool_call_id: call.id, content: result.content },
      )
    }
    if (params.shouldStop?.()) return { content: '', calls, rounds: round }
  }
}
