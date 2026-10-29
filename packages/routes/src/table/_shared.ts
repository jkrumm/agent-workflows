// The rates and fallbacks every route group shares. Ports import from here and never edit it; a new rate or fallback
// goes into the group file that first needs it. Model ids live only under this directory (guard.test.ts).
// Haiku 5.5 EU rate, USD/M: in 0.10, out 0.50, cache read 0.01, cache write 0.125 (1.25x in). Copied from
// agent-gateway server/lib/models.ts (`claude-haiku-5-5-eu`; source "hermes-agent docs/model-context-reasoning.md
// (vendor list, >100K prompt 5x); cache write 1.25x in", dated 2026-10-14). The >100K-prompt tier (5x) has no
// counterpart in `Rate`, so `costFromUsage` returns `unknown` for a call over 100K prompt tokens.
// Used by the Haiku routes on the iu-anthropic wire, whose Messages response carries no `usage.cost`, and by the
// Haiku routes on the opencode wire: the OpenCode host writes the rate into the server config's cost rows (OpenCode
// prices each message with them) and prices a message OpenCode reports at cost 0 with it.
export const HAIKU_55_EU_RATE = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 }

// Sonnet 5.5 EU rate, USD/M: in 2.00, out 10.00, cache read 0.10 (0.05x in), cache write 2.50 (5-minute, 1.25x in).
// Source: Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing), read 2026-10-29: the Sonnet 5.5 row,
// and footnote 2 "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input
// price"; the `-eu` twin shares the card (modelpick CLAUDE_LIST_RATES; agent-gateway `server/lib/models.ts` agrees on
// in/out). The page lists no long-context tier for Sonnet 5.5: the 1M window is billed at the standard rate ("long-context
// requests are billed at standard pricing, except on Claude Haiku 5.5"). `longPromptTokens` is therefore the window
// itself, 1M, so the 100K default of `Rate` (the Haiku step) does not price a long angle prompt `unknown`.
export const SONNET_55_EU_RATE = {
  inputPerM: 2,
  outputPerM: 10,
  cacheReadPerM: 0.1,
  cacheWritePerM: 2.5,
  longPromptTokens: 1_000_000,
}

// GPT-6.1 Terra, Standard tier, USD/M: in 1.00, cached in 0.05, out 5.00, cache write 1.25 (30-min). Above 272K input
// tokens the whole request bills 2x input/cache and 1.5x output; `Rate` does not model that tier, so such a call is
// priced `unknown`. Source: developers.openai.com via /research, and a probe of the IU OpenAI endpoint (listed in
// /models, chat completions with reasoning_effort=medium answered 200), both 2026-10-28. Context 1.05M, output 128K.
// IU's `usage.cost` still wins where the wire sends it.
export const TERRA_RATE = {
  inputPerM: 1,
  outputPerM: 5,
  cacheReadPerM: 0.05,
  cacheWritePerM: 1.25,
  longPromptTokens: 272_000,
}

// The provider-balance fallback (owner, 2026-10-28): a call that fails with HTTP 402, or 503 "Insufficient Balance",
// runs once more on this route instead of failing. Single calls go over IU's OpenAI chat wire; agent steps run it on
// OpenCode, whose host speaks the Responses API to it (tool calling needs Responses on this model).
export const TERRA = { model: 'gpt-6.1-terra', effort: 'medium', maxOutputTokens: 32_000, rate: TERRA_RATE } as const
export const CALL_FALLBACK = { wire: 'iu-openai', ...TERRA } as const
export const AGENT_FALLBACK = { wire: 'opencode', ...TERRA } as const
