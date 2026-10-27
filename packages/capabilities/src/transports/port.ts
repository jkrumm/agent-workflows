import type { Effort } from '@agent-workflows/routes'

/** Raw provider counts: `input` includes cache reads and writes, `output` includes reasoning tokens. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
  /** Tokens written to the prompt cache; absent on wires that report none. */
  cacheWrite?: number
  reasoning: number
}

export interface ChatRequest {
  model: string
  system?: string
  prompt: string
  maxOutputTokens: number
  effort?: Effort
  /** Ask for a JSON object (JSON mode where the wire has one). Syntax only, never the schema. */
  json?: boolean
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

/** One text completion. `iu-openai` and `iu-anthropic` both implement it. Rejects, never throws synchronously. */
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
}

export interface DecisionResult {
  model: string
  answers: Record<string, DecisionAnswer>
}

/** IU's decision API: typed answers with probabilities, no text. */
export interface DecisionPort {
  decide: (request: DecisionRequest, signal: AbortSignal, onUsage?: OnUsage) => Promise<DecisionResult>
}

export interface IuTransports {
  openai: ChatPort
  anthropic: ChatPort
  decision: DecisionPort
}
