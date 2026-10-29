import { type Cost, costFromUsage, priceCall as priceByTable } from '@agent-workflows/routes'
import type { AudioRoute } from './routes.ts'

/** What a billed upstream call was: legacy's usage endpoints, so a run record reads like audio-gateway's ledger. */
export type CallEndpoint = 'speech' | 'speech-prep' | 'speech-summary' | 'transcriptions'
export type RequestEndpoint = 'speech-request' | 'transcription-request'

export type Units = 'tokens' | 'characters' | 'audio-seconds'

/**
 * `rate`: the route's price applied; `provider`: the upstream's own `usage.cost`; `not-billed`: a failed call (no
 * audio, no tokens); `unknown`: no price or a missing quantity, never 0.
 */
export type CostSource = 'rate' | 'provider' | 'not-billed' | 'unknown'

/** The measured quantities of one call; each price reads the ones its unit needs. */
export interface Measure {
  inputTokens?: number | null
  outputTokens?: number | null
  cachedTokens?: number | null
  audioTokens?: number | null
  audioSeconds?: number | null
  inputChars?: number | null
  /** USD the provider reported (IU's `usage.cost`); wins over the rate. */
  providerCostUsd?: number | null
}

interface EventBase {
  requestId: string
  caller: string
  routeId: string | null
  model: string
  status: number
  latencyMs: number
  units: Units | null
  quantity: number | null
  costUsd: number | null
  costSource: CostSource
  /** The price's stamp: true = invoice-verified, false = list price or inference, null = no price. */
  priceVerified: boolean | null
  errorText: string | null
}

/** One per billed upstream call (incl. a failed attempt), recorded right after it, never deferred. */
export interface CallEvent extends EventBase, Measure {
  kind: 'call'
  endpoint: CallEndpoint
  bytesOut: number | null
}

/** One per door request, once its response is decided (a pcm stream: once the body ended). Costs sum the calls. */
export interface RequestEvent extends EventBase {
  kind: 'request'
  endpoint: RequestEndpoint
  /** The model the caller sent; `model` is the one that served. */
  requestedModel: string
  calls: number
  /** Calls whose cost is `unknown`: a partially priced request is visible, never a silent undercount. */
  unpricedCalls: number
  retries: number
  responseFormat: string
  /** `direct` | `prep` | `summary` (speech); null for transcriptions. */
  mode: string | null
  lane: string | null
  chunks: number | null
  languageCode: string | null
  voice: string | null
  title: string | null
  audioSeconds: number | null
  bytesOut: number | null
  inputChars: number | null
}

export type UsageEvent = CallEvent | RequestEvent

/**
 * Where usage goes. The audio process wires it to the run record (a capability-style run per request, concept N6).
 * `record` may be async or throw: the door never awaits it and isolates its failures, so the first audio byte never
 * waits on bookkeeping.
 */
export interface UsagePort {
  record(event: UsageEvent): void | Promise<void>
}

export interface Priced {
  units: Units | null
  quantity: number | null
  costUsd: number | null
  costSource: CostSource
  priceVerified: boolean | null
}

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** What a route bills by: its `price`'s unit (characters, seconds of audio), else tokens (a `rate` or an audio split). */
export function unitsOf(route: AudioRoute): Units | null {
  const price = route.price
  if (price?.kind === 'unit')
    return price.unit === 'character' ? 'characters' : price.unit === 'second' ? 'audio-seconds' : null
  return price || route.rate ? 'tokens' : null
}

/**
 * The one pricing function: the route table's price (`packages/routes` `priceCall`: per 1k characters, per minute,
 * audio-token split) or token rate (`costFromUsage`), fed this call's measure. A failed call is `not-billed` at 0. The
 * provider's own `usage.cost` wins where it sends one. A missing quantity is `unknown`, never 0; a token call that
 * reports only one side counts the other as 0 (a stream reports no output tokens, only its duration does).
 */
export function priceCall(route: AudioRoute | undefined, status: number, m: Measure): Priced {
  const units = route ? unitsOf(route) : null
  const priceVerified = route && (route.price || route.rate) ? route.priceVerified === true : null
  if (status < 200 || status >= 300)
    return { units, quantity: null, costUsd: 0, costSource: 'not-billed', priceVerified }
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const tokensKnown = n(m.inputTokens) !== null || n(m.outputTokens) !== null
  const input = n(m.inputTokens) ?? 0
  const output = n(m.outputTokens) ?? 0
  let quantity: number | null
  let cost: Cost
  const price = route?.price
  if (price?.kind === 'unit') {
    quantity = n(price.unit === 'character' ? m.inputChars : price.unit === 'second' ? m.audioSeconds : null)
    cost = priceByTable(price, {
      cost: n(m.providerCostUsd),
      ...(quantity !== null && { units: { quantity } }),
    })
  } else if (price) {
    quantity = tokensKnown ? input + output : null
    cost = priceByTable(price, {
      cost: n(m.providerCostUsd),
      ...(tokensKnown && { input_tokens: input, output_tokens: output }),
      ...(n(m.audioTokens) !== null && { input_tokens_details: { audio_tokens: n(m.audioTokens) } }),
    })
  } else {
    quantity = tokensKnown ? input + output : null
    cost = costFromUsage(
      route?.wire ?? 'iu-openai',
      {
        cost: n(m.providerCostUsd),
        ...(tokensKnown && { prompt_tokens: input, completion_tokens: output }),
        // Cache hits only where the rate prices them (as before): without a cache rate they bill as plain input.
        ...(n(m.cachedTokens) !== null &&
          route?.rate?.cacheReadPerM !== undefined && { prompt_tokens_details: { cached_tokens: n(m.cachedTokens) } }),
      },
      route?.rate,
    )
  }
  return { units, quantity, costUsd: cost.usd, costSource: cost.source, priceVerified }
}

/** OpenAI-shaped usage (chat completions, STT) read into a `Measure`; legacy `tokens()`. */
export function measureFromOpenAiUsage(usage: unknown): Measure {
  const u = (usage ?? {}) as Record<string, unknown>
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const details = (u.input_token_details ?? {}) as Record<string, unknown>
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>
  return {
    inputTokens: n(u.input_tokens) ?? n(u.prompt_tokens),
    outputTokens: n(u.output_tokens) ?? n(u.completion_tokens),
    cachedTokens: n(promptDetails.cached_tokens),
    audioTokens: n(details.audio_tokens),
    audioSeconds: n(u.prompt_audio_seconds) ?? (u.type === 'duration' ? n(u.seconds) : null),
    providerCostUsd: n(u.cost),
  }
}
