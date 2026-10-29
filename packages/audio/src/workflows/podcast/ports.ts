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
  | { ok: true; report: string; sources: string[]; usd: number | null; runId: string }
  | { ok: false; error: string }

/** The host's `research` workflow. Never throws for a failed run: the room reads `ok: false` as a tool error. */
export interface ResearchPort {
  run(query: string, depth: ResearchDepth, signal: AbortSignal, progress: () => void): Promise<ResearchAnswer>
}
