import type { Effort } from '@agent-workflows/routes'

/** Raw provider counts: `input` includes cache reads, `output` includes reasoning tokens. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
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
  /** `undefined` when the provider reported no usage. */
  tokens?: Tokens
  /** USD as the provider reports it (`usage.cost`); `null` when it does not. */
  cost: number | null
}

/** One text completion. `iu-openai` and `iu-anthropic` both implement it. */
export interface ChatPort {
  complete: (request: ChatRequest, signal: AbortSignal) => Promise<ChatResult>
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
  tokens?: { input: number; output: number }
}

/** IU's decision API: typed answers with probabilities, no text. */
export interface DecisionPort {
  decide: (request: DecisionRequest, signal: AbortSignal) => Promise<DecisionResult>
}

export interface IuTransports {
  openai: ChatPort
  anthropic: ChatPort
  decision: DecisionPort
}
