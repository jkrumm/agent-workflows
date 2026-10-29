import type { AudioPrice, AudioRoute } from './routes.ts'

/** What a billed upstream call was: legacy's usage endpoints, so a run record reads like audio-gateway's ledger. */
export type CallEndpoint = 'speech' | 'speech-prep' | 'speech-summary' | 'transcriptions'
export type RequestEndpoint = 'speech-request' | 'transcription-request'

export type Units = AudioPrice['unit']

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

/** A route's price: the lane's own (non-token, or the STT audio split), else the table's token rate. */
export function priceOf(route: AudioRoute): AudioPrice | undefined {
  if (route.price) return route.price
  if (!route.rate) return undefined
  return {
    unit: 'tokens',
    inputPerM: route.rate.inputPerM,
    outputPerM: route.rate.outputPerM,
    ...(route.rate.cacheReadPerM !== undefined && { cachedInputPerM: route.rate.cacheReadPerM }),
    stamp: { verified: false, note: 'route table rate' },
  }
}

/**
 * The one pricing function (legacy `computeCost`). A failed call is `not-billed` at 0. Per minute needs audio
 * seconds, per 1k characters needs input characters; a missing quantity is `unknown`. Tokens: the STT audio share at
 * `audioInputPerM` (all input when the split is missing, as legacy), the cached share at `cachedInputPerM`.
 */
export function priceCall(route: AudioRoute | undefined, status: number, m: Measure): Priced {
  const price = route ? priceOf(route) : undefined
  const units = price?.unit ?? null
  const verified = price ? price.stamp.verified : null
  if (status < 200 || status >= 300) {
    return { units, quantity: null, costUsd: 0, costSource: 'not-billed', priceVerified: verified }
  }
  const provider = num(m.providerCostUsd)
  if (!price) {
    if (provider !== null)
      return { units, quantity: null, costUsd: provider, costSource: 'provider', priceVerified: null }
    return { units, quantity: null, costUsd: null, costSource: 'unknown', priceVerified: null }
  }
  const unknown = (quantity: number | null): Priced => ({
    units,
    quantity,
    costUsd: null,
    costSource: 'unknown',
    priceVerified: verified,
  })
  if (price.unit === 'audio-seconds') {
    const seconds = num(m.audioSeconds)
    if (seconds === null) return unknown(null)
    return {
      units,
      quantity: seconds,
      costUsd: (seconds / 60) * price.perMinute,
      costSource: 'rate',
      priceVerified: verified,
    }
  }
  if (price.unit === 'characters') {
    const chars = num(m.inputChars)
    if (chars === null) return unknown(null)
    return {
      units,
      quantity: chars,
      costUsd: (chars / 1000) * price.per1k,
      costSource: 'rate',
      priceVerified: verified,
    }
  }
  const input = num(m.inputTokens) ?? 0
  const output = num(m.outputTokens)
  const quantity = input + (output ?? 0)
  if (provider !== null) return { units, quantity, costUsd: provider, costSource: 'provider', priceVerified: verified }
  if (output === null && num(m.inputTokens) === null) return unknown(null)
  const audioIn = price.audioInputPerM !== undefined ? (num(m.audioTokens) ?? input) : 0
  const textIn = input - audioIn
  const cachedIn = price.cachedInputPerM !== undefined ? Math.min(num(m.cachedTokens) ?? 0, textIn) : 0
  const usd =
    (textIn - cachedIn) * price.inputPerM +
    cachedIn * (price.cachedInputPerM ?? 0) +
    audioIn * (price.audioInputPerM ?? 0) +
    (output ?? 0) * price.outputPerM
  return { units, quantity, costUsd: usd / 1_000_000, costSource: 'rate', priceVerified: verified }
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
