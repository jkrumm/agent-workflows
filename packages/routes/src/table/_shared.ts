import { CLAUDE_RATES } from './claude.ts'

// The models and fallbacks every route group shares. Model ids live only under this directory (guard.test.ts), and a text
// model is chosen once, here, in one of two places: the four TIERS below, or a named cross-lab constant. A route spreads
// one (`{ wire: 'anthropic', ...FAST.call }`) and nothing else names a model, so moving every route of a tier to another
// model, rate or effort is one edit here. A route that needs another effort or output limit than its tier overrides it
// after the spread. A new rate goes next to the constant that uses it.
// GPT-6.1 Terra, Standard tier, USD/M: in 1.00, cached in 0.05, out 5.00, cache write 1.25 (30-min). Above 272K input
// tokens the whole request bills 2x input/cache and 1.5x output (`longPrompt`). Source: developers.openai.com via /research, and a probe of the IU OpenAI endpoint (listed in
// /models, chat completions with reasoning_effort=medium answered 200), both 2026-10-28. Context 1.05M, output 128K.
// IU's `usage.cost` still wins where the wire sends it.
const TERRA_RATE = {
  inputPerM: 1,
  outputPerM: 5,
  cacheReadPerM: 0.05,
  cacheWritePerM: 1.25,
  longPromptTokens: 272_000,
  longPrompt: { inputMultiplier: 2, outputMultiplier: 1.5 },
}

// Rates are USD/M tokens; IU's `usage.cost` wins on the wires that send it, the rate prices a call that lacks it.
// GPT-6 Luna: in 0.10, cached in 0.01, out 0.50 (OpenAI list price; image-gateway `pricing.ts` TEXT_RATES).
const LUNA_RATE = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 }
// DeepSeek flash: in 0.30, cache read 0.006, out 1.20 (research-gateway src/lib/cost.ts, the 2026-09-25 peak reading; an
// off-peak reading was half, so off-peak runs are over-priced, never under-priced). IU bills it at the list peak rate at
// every hour (checked on 10 days of steps, 2026-10-30). An OpenCode session never sees IU's `usage.cost`, so an agent
// route carries this rate. No cache-write price: DeepSeek reports none.
const DEEPSEEK_FLASH_RATE = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }
// Gemini 3.8 Flash, USD/M: in 0.75, out 3.75 (introductory through 2026-12-31, then 1.50 / 7.50), audio-gateway
// `src/usage.ts`. No cache rate: a call reporting cache reads without `usage.cost` is priced `unknown`, never 0.
const GEMINI_FLASH_RATE = { inputPerM: 0.75, outputPerM: 3.75 }
// Gemini 3.5 Flash-Lite: ai.google.dev pricing, read 2026-09-02.
const GEMINI_FLASH_LITE_RATE = { inputPerM: 0.3, outputPerM: 2.5 }
// The UE price list in the gateway's decision.ts, input only ($0.042/M, output $0).
const DECISION_RATE = { inputPerM: 0.042, outputPerM: 0 }

// ---- The GPT stack (owner direction 2026-10-30), by how much thinking the role needs. These are not tiers: each is the
// fallback of a tier below, or a cross-lab seat further down.
// Artificial Analysis Intelligence Index v5.0: Terra medium 38, Terra low 29, Luna medium 18 / low 10; agw's paired review
// eval (12 recorded cases, 2026-10-30) put Terra medium level with DeepSeek on verdict agreement (0.67 deep) and ahead of
// Haiku (0.58 against 0.08 at standard depth).
const LUNA = { model: 'gpt-6-luna', effort: 'low', rate: LUNA_RATE } as const
const TERRA_LOW = { model: 'gpt-6.1-terra', effort: 'low', rate: TERRA_RATE } as const
const TERRA_MEDIUM = { model: 'gpt-6.1-terra', effort: 'medium', rate: TERRA_RATE } as const

// The provider-balance fallback (owner, 2026-10-28; Claude tiers 2026-11-01): a call that fails with HTTP 402, or 503
// "Insufficient Balance", runs once more on this route instead of failing. A Claude tier's credit running out is a 402
// from the gateway (`x-agw-fallback: none`), and the fallback is GPT on IU, never IU's Claude. Single calls go over IU's
// OpenAI chat wire; agent steps run on OpenCode, whose host speaks the Responses API to Terra (tool calling needs
// Responses on that model). Every fallback has the output ceiling below.
const OUTPUT_CEILING = 32_000
const callFallback = <T extends { model: string; rate: object }>(model: T) =>
  ({ wire: 'iu-openai', ...model, maxOutputTokens: OUTPUT_CEILING }) as const
const agentFallback = <T extends { model: string; rate: object }>(model: T) =>
  ({ wire: 'opencode', ...model, maxOutputTokens: OUTPUT_CEILING }) as const

// ---- Tiers (owner, 2026-10-31): the four places a text model is chosen for a role. Each is a Claude primary, except DECIDE,
// with its GPT-on-IU fallback per step kind: `.call` is a single call (the `anthropic` wire, native Messages on the gateway,
// which pays from the credit), `.agent` an OpenCode step (`opencode`). The route chooses the kind and the wire is its own
// (a transport is code, not configuration): `{ wire: 'anthropic', ...FAST.call }`, `{ wire: 'opencode', ...HARD.agent }`.
// Both Claude wires send `x-agw-fallback: none`, so a drained credit is a 402 and the fallback runs. The rate is
// `CLAUDE_RATES` (claude.ts), the one source.
// Evidence, the 2026-10-31 eval (docs/evals/2026-10-31-review-claude-direct.md): Haiku at effort high is the Haiku knee;
// Haiku at max is unusable for agent steps. Sonnet at medium was NOT measured, and HARD was Terra medium until then.
const claudeRate = (id: string) => {
  const rate = CLAUDE_RATES[id]
  if (!rate) throw new Error(`no Claude rate for ${id}`)
  return rate
}
const HAIKU = { model: 'claude-haiku-5-5', rate: claudeRate('claude-haiku-5-5') } as const
const SONNET = { model: 'claude-sonnet-5-5', rate: claudeRate('claude-sonnet-5-5') } as const

/** Straight-up steps that need almost no judgment: labelling, titles, the factory classify (`.call`), the diagram agent (`.agent`). Haiku without thinking, falls back to Luna low (call) or Terra low (agent). */
export const FAST = {
  call: { ...HAIKU, effort: 'none', fallback: callFallback(LUNA) },
  agent: { ...HAIKU, effort: 'none', fallback: agentFallback(TERRA_LOW) },
} as const
/** Easy calls with a clear shape: summarize, extract, classify a batch, triage, route a review, run the checks. Haiku high, falls back to Terra low. */
export const EASY = {
  call: { ...HAIKU, effort: 'high', fallback: callFallback(TERRA_LOW) },
  agent: { ...HAIKU, effort: 'high', fallback: agentFallback(TERRA_LOW) },
} as const
/** Anything that judges, reads code or writes prose: deep review angles, the prose writer, the narrative, the retro agent, the podcast writers' room. Sonnet medium, falls back to Terra medium. */
export const HARD = {
  call: { ...SONNET, effort: 'medium', fallback: callFallback(TERRA_MEDIUM) },
  agent: { ...SONNET, effort: 'medium', fallback: agentFallback(TERRA_MEDIUM) },
} as const
// The IU decision API. Gateway: DEFAULT_DECISION_MODEL = pplx-decider-v1-27b, which IU serves through its "Requesty
// decision compatibility API" (response header x-middleware-forwarded-server, probed 2026-10-29). Owner direction:
// nothing routes via Requesty and no region is pinned, so this is `decision-1` (Microsoft; header "Global Sink Sweden
// Decisions API", probed 2026-10-29: 200, the same `microsoft-decision-1` model the region-pinned twin serves from the
// "GDPR Sink"): same wire and request shape, same 60k-character cap.
/** The IU decision API: `decision-1` (Microsoft), input-priced, no effort, no limit. The one tier with no fallback and no `.agent`, by design: the decision API has no second vendor and is no agent step. */
export const DECIDE = {
  call: { model: 'decision-1', rate: DECISION_RATE },
} as const

// ---- Cross-lab seats: named constants, not tiers. They stay off Claude on purpose: a reviewer of Claude-written output sits on
// another lab (docs/gateway.md §Seats). A route spreads one like a tier; each carries its rate and its fallback.
/** The second lab: the prose reviewer (`prose.review`, a cross-lab reviewer of a Claude writer). No effort (the vendor's own level). Falls back to Terra medium. */
export const DEEPSEEK_FLASH = {
  call: { model: 'deepseek-v4.1-flash', rate: DEEPSEEK_FLASH_RATE, fallback: callFallback(TERRA_MEDIUM) },
} as const
/** The podcast cross-lab reviewer. No effort: Gemini's OpenAI-compatible leg rejects `reasoning_effort`. Falls back to Terra medium. */
export const GEMINI_FLASH = {
  call: { model: 'gemini-3.8-flash', rate: GEMINI_FLASH_RATE, fallback: callFallback(TERRA_MEDIUM) },
} as const
/** The spoken summary of the audio door. No fallback. */
export const GEMINI_FLASH_LITE = {
  call: { model: 'gemini-3.5-flash-lite', rate: GEMINI_FLASH_LITE_RATE },
} as const
/** The cross-family critic of a Claude writer (`review.adversary`, `podcast.review.b`): Terra medium. Its capability refuses any wire but the OpenAI chat wire. On a provider-balance failure the critique comes from Luna medium on another backend rather than not at all. */
export const CRITIC = {
  call: { ...TERRA_MEDIUM, fallback: callFallback({ ...LUNA, effort: 'medium' as const }) },
} as const

// ---- Eval seats: pinned, never tiers; a change here bumps the labeller or judge version (`LABELER_VERSION`,
// `JUDGE_VERSION` in packages/capabilities). They carry no fallback on purpose: a fallback would silently change a
// labeller or the grader, so a drained credit fails the call and never moves it. Each seat is its own constant so a tier
// edit never reaches the ground truth.
/** Ground-truth labeller `a`: Sonnet 5.5 medium on the native Messages wire (`eval.label.a`). */
export const LABELER_CLAUDE = {
  call: { ...SONNET, effort: 'medium', maxOutputTokens: 16_000 },
} as const
/** Ground-truth labeller `b`, the other vendor: Terra medium on the chat wire (`eval.label.b`). */
export const LABELER_GPT = {
  call: { ...TERRA_MEDIUM, maxOutputTokens: 16_000 },
} as const
/** The review eval's grader: Sonnet 5.5 medium (`eval.judge`). Reasoning counts against the ceiling. */
export const JUDGE = {
  call: { ...SONNET, effort: 'medium', maxOutputTokens: 16_000 },
} as const
