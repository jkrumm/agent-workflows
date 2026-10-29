import type { EpisodeSummary } from './types.ts'

// What the room reads besides the models: the owner's vault, the show's memory, and the host's `research` workflow.
// Production adapters: `brain.ts` (the platform's vault capabilities, in-process), `history.ts` (Postgres), and
// `research-client.ts` (the host's HTTP API). Tests pass fakes.

export interface BrainHit {
  path: string
  line: number
  snippet: string
}

export type BrainNote =
  | { found: true; path: string; frontmatter: string; body: string; truncated: boolean }
  | { found: false; reason: string }

/** The vault, read-only and path-contained (capabilities `brain/`: `wiki/`, `Areas/`, `Projects/`, no dotfiles). */
export interface BrainPort {
  search(query: string, limit: number, signal: AbortSignal): Promise<{ matches: BrainHit[]; warnings: string[] }>
  read(path: string, maxChars: number, signal: AbortSignal): Promise<BrainNote>
}

/** The show's memory: finished `podcast` runs plus the imported legacy episodes, newest first, per series. */
export interface HistoryPort {
  recent(series: string, limit: number): Promise<EpisodeSummary[]>
  /** The markdown transcript of a finished episode of any series, or null when unknown. */
  transcript(id: string): Promise<string | null>
}

export type ResearchDepth = 'quick' | 'standard'

export type ResearchAnswer =
  | { ok: true; report: string; sources: string[]; runId: string }
  | { ok: false; error: string }

export interface ResearchCall {
  /**
   * The host run's idempotency key (`researchKey`): the same key starts no second run, so a resumed or retried step
   * re-attaches to the run it already paid for. The episode's research cost is read back by this key's prefix.
   */
  key: string
  signal: AbortSignal
  /** Resets the step's idle timer while the run is waited on. */
  progress: () => void
}

/** The host's `research` workflow. Never throws for a failed run: the room reads `ok: false` as a tool error. */
export interface ResearchPort {
  run(query: string, depth: ResearchDepth, call: ResearchCall): Promise<ResearchAnswer>
}

/** The key prefix of every host research run one podcast run starts. */
export const researchKeyPrefix = (runId: string) => `podcast:${runId}:`

/** A host research run's idempotency key: this run, the step that started it, the depth and query, hashed. */
export function researchKey(runId: string, stepId: string, depth: ResearchDepth, query: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(`${depth}\n${query.trim()}`).digest('hex').slice(0, 24)
  return `${researchKeyPrefix(runId)}${stepId}:${hash}`
}

/** Recorded spend: USD over the priced calls, and how many calls had no price (then `usd` is a lower bound). */
export interface Spent {
  usd: number
  unpriced: number
}

/** What an episode cost, read from the journal: the record of every call, failed attempts and retries included. */
export interface EpisodeCost {
  /** The run's own steps: every model call of the room. */
  script: Spent
  /** The host `research` runs the episode started (by their idempotency key), however many attempts started them. */
  research: Spent & { runs: number }
  /** The `podcast.produce` child run(s). */
  produce: Spent
}

/** The journal's cost record of an episode. */
export interface CostPort {
  episodeCost(runId: string): Promise<EpisodeCost>
}
