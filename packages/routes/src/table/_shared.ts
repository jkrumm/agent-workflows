// The models and fallbacks every route group shares. Model ids live only under this directory (guard.test.ts), and a text
// model that serves a role is chosen once, in the SEATS below: a route spreads a seat (`...FAST`) instead of naming the
// model, so moving every route of a role to another model, rate or effort is one edit here. A route that needs another
// effort or output limit than its seat overrides it after the spread. A new rate goes next to the seat that uses it.
// Haiku 5.5 rate, USD/M: in 0.10, out 0.50, cache read 0.01 (0.1x in), cache write 0.125 (5-minute, 1.25x in), for
// prompts up to 100K tokens. Above 100K prompt tokens (input including cache reads and writes, counted per request) the
// request bills 5x on every column: in 0.50, out 2.50, cache read 0.05, cache write 0.625. Source: Anthropic pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing), read 2026-10-29: the two Haiku 5.5 rows "(for prompts up
// to 100,000 tokens)" and "(for prompts over 100,000 tokens)", and "Long context pricing": "Claude Haiku 5.5 is priced
// by prompt length ... a request over the threshold pays the higher prices even when part of its prompt is a cache hit".
// The page lists one card and no regional variant: the card the retired region-pinned id carried (agent-gateway
// server/lib/models.ts, 2026-10-14) is the same, so the rename changes no price. Used by the Haiku routes on the iu-anthropic wire, whose
// Messages response carries no `usage.cost`, and by the Haiku routes on the opencode wire: the OpenCode host writes the
// base rate into the server config's cost rows (OpenCode prices each message with them, so it knows no tier) and
// re-prices a message above the threshold, and one OpenCode reports at cost 0, with this rate.
export const HAIKU_55_RATE = {
  inputPerM: 0.1,
  outputPerM: 0.5,
  cacheReadPerM: 0.01,
  cacheWritePerM: 0.125,
  longPromptTokens: 100_000,
  longPrompt: { inputMultiplier: 5, outputMultiplier: 5 },
}

// GPT-6.1 Terra, Standard tier, USD/M: in 1.00, cached in 0.05, out 5.00, cache write 1.25 (30-min). Above 272K input
// tokens the whole request bills 2x input/cache and 1.5x output (`longPrompt`). Source: developers.openai.com via /research, and a probe of the IU OpenAI endpoint (listed in
// /models, chat completions with reasoning_effort=medium answered 200), both 2026-10-28. Context 1.05M, output 128K.
// IU's `usage.cost` still wins where the wire sends it.
export const TERRA_RATE = {
  inputPerM: 1,
  outputPerM: 5,
  cacheReadPerM: 0.05,
  cacheWritePerM: 1.25,
  longPromptTokens: 272_000,
  longPrompt: { inputMultiplier: 2, outputMultiplier: 1.5 },
}

// ---- Seats: the one place a text model is chosen for a role. Wire stays per route (it is code, not configuration).
// DeepSeek flash, USD/M: in 0.30, cache read 0.006, out 1.20 (research-gateway src/lib/cost.ts, the 2026-09-25 peak
// reading; an off-peak reading was half, so off-peak runs are over-priced, never under-priced). IU's `usage.cost` wins on
// the wires that send it; the rate prices a call that lacks it.
export const DEEPSEEK_FLASH_RATE = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }

/** Small high-volume calls and light agents: classify, title, summarize, extract, triage, narrative, overview, the review router, OCR, angles and synthesis, check, brain, diagram, retro. */
export const FAST = { model: 'claude-haiku-5-5', rate: HAIKU_55_RATE } as const
/** Long reads and bulk generation on the cheapest capable model: research, otel, the podcast stages, cross-lab prose review, deep review angles. */
export const CHEAP = { model: 'deepseek-v4.1-flash', rate: DEEPSEEK_FLASH_RATE } as const
/** Writing and critique where quality shows: the prose writer, the review adversary. */
export const WRITER = {
  model: 'gpt-6.1-terra',
  effort: 'medium',
  maxOutputTokens: 32_000,
  rate: TERRA_RATE,
} as const
/** Short structured planning and prep calls where latency matters: the TTS briefing prep, the image enhance planner. OpenAI list price (gateway `pricing.ts` TEXT_RATES): in 0.10, cached in 0.01, out 0.50. */
export const PLANNER = { model: 'gpt-6-luna', rate: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 } } as const
/** The model a call moves to once when its primary fails on provider balance. A route whose own seat is this model takes `HAIKU_CALL_FALLBACK`. */
export const FALLBACK = { model: 'gpt-6.1-terra', effort: 'medium', maxOutputTokens: 32_000, rate: TERRA_RATE } as const

// The provider-balance fallback (owner, 2026-10-28): a call that fails with HTTP 402, or 503 "Insufficient Balance",
// runs once more on this route instead of failing. Single calls go over IU's OpenAI chat wire; agent steps run it on
// OpenCode, whose host speaks the Responses API to it (tool calling needs Responses on this model).
export const CALL_FALLBACK = { wire: 'iu-openai', ...FALLBACK } as const
export const AGENT_FALLBACK = { wire: 'opencode', ...FALLBACK } as const

// The single-call fallback for a route whose primary is the fallback model itself (it would fall back to itself): the FAST
// seat on the chat wire. Anthropic's balance is not OpenAI's.
export const HAIKU_CALL_FALLBACK = {
  wire: 'iu-openai',
  ...FAST,
  maxOutputTokens: FALLBACK.maxOutputTokens,
} as const
