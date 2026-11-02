import { costFromUsage, fallbackRoute, type ResolvedRoute } from '../../../../routes/src/index.ts'
import type { Attribution, StepScope, Usage } from '../../../../runtime/src/index.ts'
import { log } from './log.ts'
import { type PodcastRouteId, resolvePodcastRoute } from './routes.ts'
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
  /** The calling step: the gateway puts it on its usage row. */
  attribution?: Attribution
}

export interface ChatReply {
  text: string
  /** `length`: the output ceiling cut the answer; `other`: a refusal, a pause, or no stop reason. */
  stop: 'complete' | 'length' | 'other'
  stopDetail?: string
}

/**
 * What a provider sent for one assistant turn, kept to echo it back verbatim to the SAME dialect: the `/v1/responses`
 * output items, or the Messages content blocks (thinking blocks and their signatures included). Another dialect ignores it.
 */
export interface NativeTurn {
  api: 'responses' | 'anthropic'
  items: unknown[]
}

/**
 * A message as it round-trips through a tool loop: loose on purpose, so provider fields survive untouched. The
 * transcript is chat-shaped (`assistant` with `tool_calls`, `tool` results) whatever wire answered; `native` rides on an
 * assistant turn whose dialect is not chat, and `Llm.round` renders the transcript per route.
 */
export interface WireMessage {
  role?: string
  content?: string | null | unknown[]
  tool_calls?: ToolCallRequest[]
  tool_call_id?: string
  native?: NativeTurn
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

/**
 * One tool-loop round. `api: 'responses'` is IU's `/v1/responses`; `chat` is `/chat/completions`; `messages` is the
 * gateway's Anthropic Messages (`system` is the system prompt, `messages` are Messages turns).
 */
export interface RoundCall {
  api: 'chat' | 'responses' | 'messages'
  model: string
  effort?: string
  system?: string
  messages: WireMessage[]
  tools: ToolSchema[]
  maxTokens: number
  attribution?: Attribution
}

/**
 * A round's reply normalised across the APIs: the assistant message in chat shape. `raw` (responses) or
 * `message.native` (Messages) is what goes back into the transcript for its own dialect; chat's `message` is native.
 */
export interface RoundReply {
  message: WireMessage
  finishReason?: string
  raw?: WireMessage[]
}

/**
 * The transport. Rejects with a `ModelError` on a failed call; reports every billed attempt to `onUsage`, and calls
 * `onSent` each time a request leaves (a call that never sent one cannot have billed).
 */
export interface ModelPort {
  chat(call: ChatCall, signal: AbortSignal, onUsage: OnWireUsage, onSent: () => void): Promise<ChatReply>
  round(call: RoundCall, signal: AbortSignal, onUsage: OnWireUsage, onSent: () => void): Promise<RoundReply>
}

/**
 * A failed model call. `balance`: the provider refused for account balance; the route's fallback answers it.
 * `requestId`: the gateway's `x-agw-request-id` of the refusing response, which the fallback call names as
 * `x-agw-route-fallback`.
 */
export class ModelError extends Error {
  override name = 'ModelError'
  constructor(
    message: string,
    readonly balance = false,
    readonly requestId?: string,
  ) {
    super(message)
  }
}

/**
 * A tool loop's fallback state, shared by its rounds: set when a balance failure moved a round to the fallback.
 * `refused` is that refusal's request id, which every later round on the fallback names too.
 */
export interface FallbackPin {
  onFallback: boolean
  refused?: string
}

/** IU serves function tools for the GPT-6.1 family only on `/v1/responses` (chat/completions 503s; probed 2026-10-26). */
export const usesResponsesApi = (model: string): boolean => /^gpt-6\.1/.test(model)

/** Reasoning tokens count against `max_tokens` on the Messages wire: a thinking writer needs room. */
export const ANTHROPIC_MIN_MAX_TOKENS = 32_000
/** The ceiling a Messages round's retry doubles up to. */
const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000

/**
 * A Messages round's wire `max_tokens`: the budget floored at 32k; the retry doubles THAT (so it differs from the first
 * try whatever the caller asked for), up to 64k.
 */
function messagesBudget(maxTokens: number, retry: boolean): number {
  const first = Math.max(ANTHROPIC_MIN_MAX_TOKENS, maxTokens)
  return retry ? Math.max(first, Math.min(ANTHROPIC_MAX_OUTPUT_TOKENS, first * 2)) : first
}

/**
 * The model calls of ONE step, bound to its `addUsage` and signal. What they cost lives in the journal only (the
 * step's recorded usage, retries and failed attempts included); nothing here sums it.
 */
export class Llm {
  constructor(
    private readonly port: ModelPort,
    private readonly scope: Pick<StepScope, 'addUsage' | 'signal' | 'progress' | 'arm'> & { attribution?: Attribution },
    // The step's run's arm patches the room's routes; a run without one resolves the table.
    private readonly resolve: (id: PodcastRouteId) => ResolvedRoute = (id) =>
      resolvePodcastRoute(id, scope.arm?.routes),
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

  /** The step's attribution; on a fallback call, with the refused request's id as `routeFallback`. */
  private attribution(refused?: string): { attribution?: Attribution } {
    const attribution = this.scope.attribution
    if (!attribution) return {}
    return { attribution: refused ? { ...attribution, routeFallback: refused } : attribution }
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
    this.scope.addUsage(priced)
    this.scope.progress()
  }

  /** A call that came back with no usage: unpriced in the record, never priced at $0 by a rate over zero tokens. */
  private reportUnknown(model: string) {
    this.scope.addUsage({
      model,
      tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      cost: null,
      costSource: 'unknown',
    })
  }

  /**
   * Runs `call` on the route; a provider-balance failure moves it once to the route's fallback (concept v3.3). A call
   * that came back without usage is still reported, unpriced, under the model it ran on.
   */
  private async onRoute<T>(
    id: PodcastRouteId,
    call: (route: ResolvedRoute, onUsage: OnWireUsage, onSent: () => void, refused?: string) => Promise<T>,
    pin?: FallbackPin,
  ) {
    const primary = this.route(id)
    /** `refused`: set on a fallback attempt, the request id of the balance refusal it replaces. */
    const attempt = async (route: ResolvedRoute, refused?: string) => {
      let reported = 0
      let sent = 0
      try {
        return await call(
          route,
          (usage) => {
            reported++
            this.report(route, usage)
          },
          () => sent++,
          refused,
        )
      } finally {
        // A request left and no usage came back: it may have billed. Nothing sent (a pre-flight error, an abort before
        // the send) is nothing to record.
        if (reported === 0 && sent > 0) this.reportUnknown(route.model)
      }
    }
    // A loop that already moved to the fallback stays there: its transcript carries the fallback's turns.
    const pinned = pin?.onFallback ? fallbackRoute(primary) : undefined
    if (pinned) return attempt(pinned, pin?.refused)
    try {
      return await attempt(primary)
    } catch (error) {
      const fallback = fallbackRoute(primary)
      if (!fallback || !(error instanceof ModelError) || !error.balance) throw error
      log.warn('podcast provider balance exhausted; falling back', { route: id, to: fallback.model })
      if (pin) {
        pin.onFallback = true
        pin.refused = error.requestId
      }
      return attempt(fallback, error.requestId)
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
    const reply = await this.onRoute(params.route, (route, onUsage, onSent, refused) =>
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
          ...this.attribution(refused),
        },
        this.scope.signal,
        onUsage,
        onSent,
      ),
    )
    if (!reply.text.trim()) {
      log.warn('podcast writer returned no content', { stage: params.stage, stop: reply.stopDetail ?? reply.stop })
      return ''
    }
    const anthropic = this.route(params.route).wire === 'anthropic'
    if (reply.stop !== 'complete' && (anthropic || (params.retryOnTruncation && reply.stop === 'length'))) {
      log.warn('podcast writer did not finish, forcing retry', {
        stage: params.stage,
        stop: reply.stopDetail ?? reply.stop,
      })
      return ''
    }
    return reply.text
  }

  /**
   * One tool-loop round on the route: Messages on an `anthropic` route, IU's OpenAI dialect otherwise (chat, or
   * responses for the GPT-6.1 family). `transcript` is chat-shaped and rendered for the wire that answers this round.
   * `pin` is the loop's fallback state: a balance failure moves the round to the route's fallback and the rest of the
   * loop stays there. `retry` is the doubled-budget second try of a cut round.
   */
  round(
    id: PodcastRouteId,
    transcript: WireMessage[],
    tools: ToolSchema[],
    maxTokens: number,
    { pin, retry = false }: { pin?: FallbackPin; retry?: boolean } = {},
  ): Promise<RoundReply> {
    return this.onRoute(
      id,
      (route, onUsage, onSent, refused) => {
        // A route on another wire fails here, loudly, instead of sending a provider a body it cannot read.
        if (route.wire !== 'iu-openai' && route.wire !== 'anthropic') {
          throw new ModelError(
            `route ${id} is on the ${route.wire} wire; the tool loop speaks only iu-openai and anthropic`,
          )
        }
        const base = {
          model: route.model,
          ...(route.effort && route.effort !== 'none' ? { effort: route.effort } : {}),
          tools,
          ...this.attribution(refused),
        }
        const budget = retry ? maxTokens * 2 : maxTokens
        const call: RoundCall =
          route.wire === 'anthropic'
            ? { api: 'messages', ...base, maxTokens: messagesBudget(maxTokens, retry), ...renderMessages(transcript) }
            : usesResponsesApi(route.model)
              ? { api: 'responses', ...base, maxTokens: budget, messages: renderResponses(transcript) }
              : { api: 'chat', ...base, maxTokens: budget, messages: renderChat(transcript) }
        return this.port.round(call, this.scope.signal, onUsage, onSent)
      },
      pin,
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
// Transcript rendering
// ---------------------------------------------------------------------------
// The loop's transcript is chat-shaped and append-only. Each round renders it for the wire that answers: an assistant
// turn that came from the same dialect goes back verbatim (`native`), anything else is rebuilt from its chat fields, so a
// loop that moves to the route's fallback mid-run continues on the other dialect (thinking blocks are dropped there).

const textOf = (m: WireMessage) => (typeof m.content === 'string' ? m.content : '')

function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Chat completions: `native` is dropped; a chat reply is its own native form and passes untouched. */
export function renderChat(transcript: WireMessage[]): WireMessage[] {
  return transcript.map((m) => {
    if (!m.native) return m
    const { native: _native, ...message } = m
    return message
  })
}

/** Responses: the system message stays (the body lifts it into `instructions`), tool results become `function_call_output`. */
export function renderResponses(transcript: WireMessage[]): WireMessage[] {
  return transcript.flatMap((m): WireMessage[] => {
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' }]
    if (m.role !== 'assistant') return [m]
    if (m.native?.api === 'responses') return m.native.items as WireMessage[]
    const text = textOf(m)
    return [
      ...(text ? [{ role: 'assistant', content: text }] : []),
      ...(m.tool_calls ?? []).map((c) => ({
        type: 'function_call',
        call_id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
    ]
  })
}

/**
 * Messages: the system prompt apart, an assistant turn as content blocks, consecutive results as ONE user turn. Every
 * message is a block array, so the transcript is the same bytes from one round to the next.
 */
export function renderMessages(transcript: WireMessage[]): { system: string; messages: WireMessage[] } {
  const system: string[] = []
  const messages: WireMessage[] = []
  let results: unknown[] | undefined
  for (const m of transcript) {
    if (m.role === 'tool') {
      const result = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }
      if (results) results.push(result)
      else {
        results = [result]
        messages.push({ role: 'user', content: results })
      }
      continue
    }
    results = undefined
    if (m.role === 'system') system.push(textOf(m))
    else if (m.role === 'assistant') {
      const text = textOf(m)
      const blocks =
        m.native?.api === 'anthropic'
          ? m.native.items
          : [
              ...(text ? [{ type: 'text', text }] : []),
              ...(m.tool_calls ?? []).map((c) => ({
                type: 'tool_use',
                id: c.id,
                name: c.function.name,
                input: parseArguments(c.function.arguments),
              })),
            ]
      messages.push({ role: 'assistant', content: blocks })
    } else {
      // Always blocks: a string and a text block are the same prompt, but the cache breakpoint needs a block to sit on.
      const text = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
      messages.push({ role: 'user', content: text })
    }
  }
  return { system: system.join('\n\n'), messages }
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

const textContent = (reply: RoundReply) => (typeof reply.message.content === 'string' ? reply.message.content : '')

const isMessages = (reply: RoundReply) => reply.message.native?.api === 'anthropic'

/**
 * A Messages stop other than `end_turn`/`stop_sequence`, `tool_use` and `max_tokens` (a `refusal`, a `pause_turn`,
 * anything new) is no answer and no budget problem: retrying it repeats it, so it fails at once, naming the reason.
 */
function assertKnownStop(reply: RoundReply, params: ToolLoopParams, round: number) {
  if (!isMessages(reply)) return
  const stop = reply.finishReason ?? 'none'
  if (stop === 'stop' || stop === 'tool_calls' || stop === 'length') return
  throw new ModelError(`Podcast ${params.stage} tool loop round ${round}: the model stopped with stop_reason=${stop}`)
}

/**
 * One round, repeated once with a doubled budget when it was cut for budget reasons: a terminal reply with empty
 * content, or ANY round whose `finish_reason` is `length` (a tool call can be cut mid-`arguments` too). Throws when the
 * retry is still empty with no tool call, instead of parsing "" downstream. A Messages reply cut at `max_tokens` is
 * never taken as it is (a half-written answer): retried, and a retry that is cut again throws. The doubled Messages
 * budget is the wire's (`messagesBudget`).
 */
async function roundWithRetry(
  llm: Llm,
  params: ToolLoopParams,
  messages: WireMessage[],
  round: number,
  pin: FallbackPin,
) {
  const schemas = params.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  const first = await llm.round(params.route, messages, schemas, params.maxCompletionTokens, { pin })
  assertKnownStop(first, params, round)
  if (first.finishReason !== 'length' && (hasToolCalls(first) || textContent(first).trim())) return first
  log.warn('podcast tool loop round truncated or empty, retrying with doubled budget', {
    stage: params.stage,
    round,
    finishReason: first.finishReason ?? null,
  })
  const retried = await llm.round(params.route, messages, schemas, params.maxCompletionTokens, { pin, retry: true })
  assertKnownStop(retried, params, round)
  const cutAgain = isMessages(retried) && retried.finishReason === 'length'
  if (!cutAgain && (hasToolCalls(retried) || textContent(retried).trim())) return retried
  throw new Error(
    `Podcast ${params.stage} tool loop round ${round} returned empty content (finish_reason=${retried.finishReason ?? 'unknown'}) after retry with doubled budget`,
  )
}

/**
 * System + user message, then rounds of tool calls executed in order, until the model answers without one: no round
 * cap (rules/agent-limits.md). The assistant message is echoed back EXACTLY as received, never rebuilt from parsed
 * fields: a provider that carries state in opaque fields (Gemini's `thought_signature`, DeepSeek's reasoning) fails
 * the next request when it does not round-trip, and an edited history breaks the prompt cache. Tool results are
 * appended, the head is never rewritten. The transcript stays chat-shaped; on `/v1/responses` the output items and on
 * Messages the content blocks (thinking signatures included) ride along as `native` and are echoed verbatim to their own
 * dialect (`Llm.round` renders per wire). A balance failure mid-loop moves that round to the route's fallback and the
 * loop STAYS on it: the transcript keeps going, rendered for the fallback's dialect with the Claude thinking blocks
 * dropped, no tool is run twice, and a Claude route is not asked again with turns it never wrote.
 */
export async function runToolLoop(llm: Llm, params: ToolLoopParams): Promise<ToolLoopResult> {
  const toolsByName = new Map(params.tools.map((t) => [t.name, t] as const))
  const messages: WireMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userContent },
  ]
  const calls: ToolCallRecord[] = []
  const pin: FallbackPin = { onFallback: false }
  for (let round = 1; ; round++) {
    const { message, raw } = await roundWithRetry(llm, params, messages, round, pin)
    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length === 0) {
      return { content: typeof message.content === 'string' ? message.content : '', calls, rounds: round }
    }
    messages.push(raw ? { ...message, native: { api: 'responses', items: raw } } : message)
    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name)
      const result = tool
        ? await runTool(tool, call)
        : {
            content: `error: unknown tool "${call.function.name}"`,
            record: { tool: call.function.name, args: call.function.arguments, ok: false, ms: 0 },
          }
      calls.push(result.record)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
    }
    if (params.shouldStop?.()) return { content: '', calls, rounds: round }
  }
}
