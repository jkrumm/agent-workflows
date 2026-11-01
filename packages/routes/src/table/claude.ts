import type { Rate, RouteEntry } from '../schema.ts'

// The Claude models the inference gateway serves and prices (docs/gateway.md §Model aliases). Model ids live only under
// this directory (guard.test.ts). The registry treats every file here as a route group, so this file is one with no
// routes: `routes` below is empty, and the models, aliases and rates are named exports that `src/index.ts` wraps
// (`resolveModelAlias`, `claudeRate`, `CLAUDE_MODELS`).
//
// Rates, USD per MTok. Haiku 5.5 and Sonnet 5.5: verified 2026-11-01 by the Admin API cost report on our org. All three,
// including the 1h cache write: Anthropic's pricing page, https://docs.anthropic.com/en/docs/about-claude/pricing, read
// 2026-11-01 via `agw web read`, and cross-checked against usage-tracker's list-price table
// (src/prices/anthropic-table.test.ts). Cache write: 5m is 1.25x input, 1h is 2x input. Cache read: 0.05x input on Opus and
// Sonnet 5.5, 0.1x on Haiku 5.5.
//
// Long prompts: only Haiku 5.5 has a tier. A request whose prompt (input plus cache reads and writes) is over 100,000
// tokens bills every column at 5x, the whole request (input, output, cache read, both cache writes). Opus 5.5 and
// Sonnet 5.5 bill the full 1M context at the standard rate. The Admin API cost report labels its context tiers 0-200k /
// 200k-1M instead; the pricing page's 100,000 is used here (2026-11-01), so a Haiku request between 100k and 200k
// prompt tokens is priced at the tier though the cost report may file it under the lower bucket. Re-check when the
// reconciled spend drifts on Haiku.
const CLAUDE_HAIKU_RATE = {
  inputPerM: 0.1,
  outputPerM: 0.5,
  cacheReadPerM: 0.01,
  cacheWritePerM: 0.125,
  cacheWrite1hPerM: 0.2,
  longPromptTokens: 100_000,
  longPrompt: { inputMultiplier: 5, outputMultiplier: 5 },
} satisfies Rate

const CLAUDE_SONNET_RATE = {
  inputPerM: 2,
  outputPerM: 10,
  cacheReadPerM: 0.1,
  cacheWritePerM: 2.5,
  cacheWrite1hPerM: 4,
} satisfies Rate

const CLAUDE_OPUS_RATE = {
  inputPerM: 4,
  outputPerM: 20,
  cacheReadPerM: 0.2,
  cacheWritePerM: 5,
  cacheWrite1hPerM: 8,
} satisfies Rate

/** A `Rate` with every level readonly, the type of the shared frozen rates. */
export type ClaudeRate = Readonly<Omit<Rate, 'longPrompt'>> & {
  readonly longPrompt?: Readonly<NonNullable<Rate['longPrompt']>>
}

/** A deeply frozen copy; the argument is left as it is. */
const frozen = (rate: Rate): ClaudeRate => {
  const copy = structuredClone(rate)
  if (copy.longPrompt) Object.freeze(copy.longPrompt)
  return Object.freeze(copy)
}

/** Concrete id to its rate, deeply frozen. The key set is the one list of Claude models. */
export const CLAUDE_RATES: Readonly<Record<string, ClaudeRate>> = Object.freeze({
  'claude-haiku-5-5': frozen(CLAUDE_HAIKU_RATE),
  'claude-sonnet-5-5': frozen(CLAUDE_SONNET_RATE),
  'claude-opus-5-5': frozen(CLAUDE_OPUS_RATE),
})

/**
 * A dated snapshot (`claude-sonnet-5-5-20261001`) or the context-window flag Claude Code appends (`[1m]`, same schedule:
 * usage-tracker's price aliases) is the same model at the same rate. The match is on these models only.
 */
export const CLAUDE_SNAPSHOT_ID = /^(claude-(?:haiku|sonnet|opus)-5-5)(?:-[0-9]{8})?(?:\[1m\])?$/

/** The short names a caller may send instead of an id: `haiku | sonnet | opus` to the current model of that tier. */
export const CLAUDE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
})

const routes = {} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
