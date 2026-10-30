// The models and fallbacks every route group shares. Model ids live only under this directory (guard.test.ts), and a text
// model that serves a role is chosen once, in the SEATS below: a route spreads a seat (`...EASY`) instead of naming the
// model, so moving every route of a role to another model, rate or effort is one edit here. A route that needs another
// effort or output limit than its seat overrides it after the spread. A new rate goes next to the seat that uses it.
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
// Rates are USD/M tokens; IU's `usage.cost` wins on the wires that send it, the rate prices a call that lacks it.
// GPT-6 Luna: in 0.10, cached in 0.01, out 0.50 (OpenAI list price; image-gateway `pricing.ts` TEXT_RATES).
export const LUNA_RATE = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 }
// DeepSeek flash: in 0.30, cache read 0.006, out 1.20 (research-gateway src/lib/cost.ts, the 2026-09-25 peak reading; an
// off-peak reading was half, so off-peak runs are over-priced, never under-priced).
export const DEEPSEEK_FLASH_RATE = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }

// The GPT stack (owner direction 2026-10-30), by how much thinking the role needs. Artificial Analysis Intelligence Index
// v5.0: Terra medium 38, Terra low 29, Luna medium 18 / low 10; agw's paired review eval (12 recorded cases, 2026-10-30)
// put Terra medium level with DeepSeek on verdict agreement (0.67 deep) and ahead of Haiku (0.58 against 0.08 at standard depth).
/** Straight-up single calls that need almost no judgment: labelling, titles, the TTS prep, the image enhance planner. */
export const TRIVIAL = { model: 'gpt-6-luna', effort: 'low', rate: LUNA_RATE } as const
/** Easy calls with a clear shape: summarize, extract, classify a batch, triage, route a review, run the checks. */
export const EASY = { model: 'gpt-6.1-terra', effort: 'low', rate: TERRA_RATE } as const
/** Anything that judges, reads code or writes prose: review angles, synthesis and adversary, the prose and podcast writers, the narrative, diagram and retro agents. */
export const STRONG = { model: 'gpt-6.1-terra', effort: 'medium', rate: TERRA_RATE } as const
/** The second lab: cross-lab reviewers, the long-read agents the benchmarks favour it on (research, otel), and the balance fallback of the GPT-stack routes, since OpenAI's balance is not DeepSeek's. */
export const CHEAP = { model: 'deepseek-v4.1-flash', rate: DEEPSEEK_FLASH_RATE } as const
// The provider-balance fallback (owner, 2026-10-28): a call that fails with HTTP 402, or 503 "Insufficient Balance", runs
// once more on this route instead of failing. A route on the GPT stack falls back to the other lab; a route on DeepSeek
// falls back to Terra. Single calls go over IU's OpenAI chat wire; agent steps run on OpenCode, whose host speaks the
// Responses API to Terra (tool calling needs Responses on that model).
const OUTPUT_CEILING = 32_000
export const OPENAI_CALL_FALLBACK = {
  wire: 'iu-openai',
  ...CHEAP,
  effort: 'high',
  maxOutputTokens: OUTPUT_CEILING,
} as const
export const OPENAI_AGENT_FALLBACK = { wire: 'opencode', ...CHEAP, maxOutputTokens: OUTPUT_CEILING } as const
// The four routes owner-directed off Requesty (cheap.classify, review.router, review.ocr, review.adversary) fall back
// across the two GPT models instead: DeepSeek flash is a Requesty-hosted model. On the chat wire Luna answers from Azure
// Sweden Central and Terra from AWS us-east-1 (probed 2026-10-30), so one backend's balance failure leaves the other.
export const LUNA_CALL_FALLBACK = {
  wire: 'iu-openai',
  ...TRIVIAL,
  effort: 'medium',
  maxOutputTokens: OUTPUT_CEILING,
} as const
export const CALL_FALLBACK = { wire: 'iu-openai', ...STRONG, maxOutputTokens: OUTPUT_CEILING } as const
export const AGENT_FALLBACK = { wire: 'opencode', ...STRONG, maxOutputTokens: OUTPUT_CEILING } as const
