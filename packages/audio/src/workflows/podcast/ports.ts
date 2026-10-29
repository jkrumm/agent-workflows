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
/** The keys one step's research runs start under. */
export const researchStepPrefix = (runId: string, stepId: string) => `${researchKeyPrefix(runId)}${stepId}:`

/** A host research run's idempotency key: this run, the step that started it, the depth and query, hashed. */
export function researchKey(runId: string, stepId: string, depth: ResearchDepth, query: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(`${depth}\n${query.trim()}`).digest('hex').slice(0, 24)
  return `${researchKeyPrefix(runId)}${stepId}:${hash}`
}

/**
 * The key a question runs under, given the runs its step already started. The host keeps a key's run for good, ended
 * or not (`insertRun ... on conflict do nothing`): a repeat of a key re-attaches to a going run and gets a finished
 * one's answer free, but would get a failed or cancelled run back forever. So a question whose run under the base key
 * ended badly runs once more under the host's attempt-key convention (`base:2`, host `attempt-keys.ts`), and no more.
 */
export function researchRunKey(base: string, started: ReadonlyMap<string, string>): string {
  const status = started.get(base)
  return status === 'failed' || status === 'cancelled' ? `${base}:2` : base
}

/** Whether a question already has a finished answer under its keys (a repeat is then free). */
export const researchAnswered = (base: string, started: ReadonlyMap<string, string>): boolean =>
  started.get(base) === 'done' || started.get(`${base}:2`) === 'done'

/** One step's started runs by key, from the journal: only keys of this step (not of a step whose id extends it). */
export function startedByKey(stepPrefix: string, runs: StartedResearch[]): Map<string, string> {
  const own = (key: string) => key.startsWith(stepPrefix) && /^[0-9a-f]{24}(:2)?$/.test(key.slice(stepPrefix.length))
  return new Map(runs.filter((r) => own(r.key)).map((r) => [r.key, r.status]))
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
  /**
   * The host `research` runs the episode started (by their idempotency key), however many attempts started them.
   * `pending`: runs (or their steps) that had not ended when this was read; above 0 the figure is a lower bound.
   */
  research: Spent & { runs: number; pending: number }
  /** The `podcast.produce` child run(s). */
  produce: Spent
}

/** A host `research` run started under one of this episode's keys, as the journal holds it. */
export type StartedResearch = {
  key: string
  status: string
}

/** The journal as the room reads it: the episode's recorded cost, and the research runs a step already started. */
export interface PodcastJournal {
  episodeCost(runId: string): Promise<EpisodeCost>
  /** Every research run whose idempotency key starts with `keyPrefix`. */
  startedResearch(keyPrefix: string): Promise<StartedResearch[]>
}
