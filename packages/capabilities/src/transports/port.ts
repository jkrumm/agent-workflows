import type { Effort } from '@agent-workflows/routes'
import type { Attribution } from '../context.ts'
import type { JsonSchema } from './json-schema.ts'

/** Raw provider counts: `input` includes cache reads and writes, `output` includes reasoning tokens. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
  /** Tokens written to the prompt cache; absent on wires that report none. */
  cacheWrite?: number
  /** The part of `cacheWrite` written with the 1 h TTL (priced at the 1 h rate); absent on wires that report none. */
  cacheWrite1h?: number
  reasoning: number
}

export interface ChatRequest {
  model: string
  system?: string
  prompt: string
  /** Pictures that go with the prompt (PNG, JPEG, WebP, GIF), base64 without a `data:` prefix. Both wires send them ahead of the prompt's text. */
  images?: { mime: string; base64: string }[]
  maxOutputTokens: number
  effort?: Effort
  /** Ask for a JSON object (JSON mode where the wire has one). Syntax only; `jsonSchema` is the stronger ask and wins. */
  json?: boolean
  /**
   * The answer's JSON Schema (`toJsonSchema`): `anthropic` sends it as `output_config.format`, `iu-openai` as a strict
   * `response_format` where the model and the schema allow it, else as JSON mode. The zod parse stays the last check.
   */
  jsonSchema?: JsonSchema
  /** Sent to the gateway as `x-agw-*` headers (`gatewayHeaders`). */
  attribution?: Attribution
}

export interface ChatResult {
  /** The visible answer, trimmed. Empty when the model produced none. */
  text: string
  /** `length`: the output ceiling ended the answer. `other`: a refusal, a pause, or no stop reason on a wire that always sends one. */
  stop: 'complete' | 'length' | 'other'
  stopDetail?: string
  model: string
}

/**
 * What one attempt cost, as the provider reported it. An adapter reports every attempt that came
 * back with usage, including one that then failed (a stream cut before its finish chunk, a 200 whose
 * body is unusable), because the provider billed it. Retries of requests that returned no usage report nothing.
 */
export interface AttemptUsage {
  model: string
  tokens: Tokens
  /** USD as the provider reports it (`usage.cost`); `null` when it does not. */
  cost: number | null
}

export type OnUsage = (usage: AttemptUsage) => void

/** One text completion. `iu-openai` and `anthropic` both implement it. Rejects, never throws synchronously. */
export interface ChatPort {
  complete: (request: ChatRequest, signal: AbortSignal, onUsage?: OnUsage) => Promise<ChatResult>
}

export type DecisionQuestion =
  | { type: 'choice'; instructions: string; options: Record<string, string | null> }
  | { type: 'boolean'; instructions: string }

export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: 'boolean'; probability: number }

export interface DecisionRequest {
  model: string
  state: string
  questions: Record<string, DecisionQuestion>
  /** Sent to the gateway as `x-agw-*` headers (`gatewayHeaders`). */
  attribution?: Attribution
}

export interface DecisionResult {
  model: string
  answers: Record<string, DecisionAnswer>
}

/** IU's decision API: typed answers with probabilities, no text. */
export interface DecisionPort {
  decide: (request: DecisionRequest, signal: AbortSignal, onUsage?: OnUsage) => Promise<DecisionResult>
}

/** The wires on the local gateway, which holds every provider key. */
export interface GatewayTransports {
  openai: ChatPort
  anthropic: ChatPort
  decision: DecisionPort
}
