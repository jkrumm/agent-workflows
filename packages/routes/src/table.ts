import { ROUTE_ID, type RouteEntry, routeSchema } from './schema.ts'

// The only place model ids live in this repo (concept §4, §5; enforced by guard.test.ts).
// Each entry's model and effort are what agent-gateway's server/lib/routing.ts resolves today
// (`GET /api/routing`, 2026-10-27). The README lists the source seat of every route.
// Haiku 5.5 EU rate, USD/M: in 0.10, out 0.50, cache read 0.01, cache write 0.125 (1.25x in). Copied from
// agent-gateway server/lib/models.ts (`claude-haiku-5-5-eu`; source "hermes-agent docs/model-context-reasoning.md
// (vendor list, >100K prompt 5x); cache write 1.25x in", dated 2026-10-14). The >100K-prompt tier (5x) has no
// counterpart in `Rate`, so `costFromUsage` returns `unknown` for a call over 100K prompt tokens.
// Used by the Haiku routes on the iu-anthropic wire, whose Messages response carries no `usage.cost`, and by the
// Haiku routes on the opencode wire: the OpenCode host writes the rate into the server config's cost rows (OpenCode
// prices each message with them) and prices a message OpenCode reports at cost 0 with it.
const HAIKU_55_EU_RATE = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 }

// Sonnet 5.5 EU rate, USD/M: in 2.00, out 10.00, cache read 0.10 (0.05x in), cache write 2.50 (5-minute, 1.25x in).
// Source: Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing), read 2026-10-29: the Sonnet 5.5 row,
// and footnote 2 "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input
// price"; the `-eu` twin shares the card (modelpick CLAUDE_LIST_RATES; agent-gateway `server/lib/models.ts` agrees on
// in/out). The page lists no long-context tier for Sonnet 5.5: the 1M window is billed at the standard rate ("long-context
// requests are billed at standard pricing, except on Claude Haiku 5.5"). `longPromptTokens` is therefore the window
// itself, 1M, so the 100K default of `Rate` (the Haiku step) does not price a long angle prompt `unknown`.
const SONNET_55_EU_RATE = {
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
const TERRA_RATE = {
  inputPerM: 1,
  outputPerM: 5,
  cacheReadPerM: 0.05,
  cacheWritePerM: 1.25,
  longPromptTokens: 272_000,
}

// The provider-balance fallback (owner, 2026-10-28): a call that fails with HTTP 402, or 503 "Insufficient Balance",
// runs once more on this route instead of failing. Single calls go over IU's OpenAI chat wire; agent steps run it on
// OpenCode, whose host speaks the Responses API to it (tool calling needs Responses on this model).
const TERRA = { model: 'gpt-6.1-terra', effort: 'medium', maxOutputTokens: 32_000, rate: TERRA_RATE } as const
const CALL_FALLBACK = { wire: 'iu-openai', ...TERRA } as const
const AGENT_FALLBACK = { wire: 'opencode', ...TERRA } as const

const TABLE = {
  // Cheap single-shot seats. Gateway: SINGLE_SHOT (triage) over the iu-openai transport.
  // single-shot.ts sends max_completion_tokens >= 16000, because reasoning tokens count against it.
  'cheap.classify': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Gateway: CLASSIFY tier (overview, narrative), a Haiku 5.5 EU session on OpenCode. The platform
  // calls it as one native Messages request; the model is unchanged. The model exposes no effort.
  'cheap.summarize': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: CALL_FALLBACK,
  },
  'cheap.title': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: CALL_FALLBACK,
  },

  // IU decision API. Gateway: DEFAULT_DECISION_MODEL; rates are the UE price list in decision.ts.
  decide: { wire: 'iu-decision', model: 'pplx-decider-v1-27b', rate: { inputPerM: 0.04, outputPerM: 0.04 } },

  // Review seats. Gateway: review_router is SINGLE_SHOT; adversary is deepseek-v4.1-flash on iu-openai.
  'review.router': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  'review.adversary': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Gateway: review_ocr (transport external-iu). `ocr` is an external CLI that talks to IU itself; the platform only
  // takes the model from here, and the wire says which of the CLI's protocols to speak (openai: chat completions).
  'review.ocr': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', fallback: CALL_FALLBACK },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry)
  // and `review` (synthesis, CLASSIFY tier), both Haiku 5.5 EU on the OpenCode harness.
  'review.angle': {
    wire: 'opencode',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },
  // Angles of a review the caller asked to run `depth: deep` (mother decision, 2026-10-29; Wave 6 experiment, 20 paired
  // cases: Haiku -> Sonnet angles recall 0.017 -> 0.13, precision 0.10 -> 0.50, cost per review $0.057 -> $0.542, about
  // 10x). Opt-in: a router-chosen deep keeps `review.angle`. The review workflow names this route in the angle steps'
  // `options.route`.
  'review.angle.deep': {
    wire: 'opencode',
    model: 'claude-sonnet-5-5-eu',
    rate: SONNET_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },
  'review.synthesis': {
    wire: 'opencode',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },

  // Prose review seat. Gateway: `prose_review` (SINGLE_SHOT, iu-openai). The reviewer must be a different lab than the
  // writer, and the writer is the calling Claude Code session (Anthropic): the capability refuses an Anthropic route.
  'prose.review': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },

  // Check seat. Gateway: `check`, CLASSIFY tier.
  check: { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE, fallback: AGENT_FALLBACK },

  // Retrospective seat (concept §7): one agent step over sampled run records, JSON out. Same model and wire as `check`.
  'retro.analyze': { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE, fallback: AGENT_FALLBACK },

  // Research agent seat (concept P3): research-gateway's lead and worker model, the same model as `review.adversary`.
  // Single calls on this model are priced by IU's `usage.cost`; an OpenCode session never sees that field and prices
  // each message with the config's cost rows, so the route carries the rate IU's `usage.cost` was measured at:
  // USD/M in 0.30, cache read 0.006, out 1.20 (research-gateway src/lib/cost.ts, the 2026-09-25 peak reading, its
  // conservative row; an off-peak reading was half). No cache-write price: DeepSeek reports none.
  'research.agent': {
    wire: 'opencode',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    rate: { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 },
    fallback: AGENT_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export type RouteId = keyof typeof TABLE

function build(): Readonly<Record<RouteId, Readonly<RouteEntry>>> {
  const out: Record<string, Readonly<RouteEntry>> = {}
  for (const [id, entry] of Object.entries(TABLE)) {
    if (!ROUTE_ID.test(id)) throw new Error(`route table: invalid route id "${id}"`)
    const parsed = routeSchema.safeParse(entry)
    if (!parsed.success) throw new Error(`route table: "${id}" is invalid: ${parsed.error.message}`)
    // The parsed copy is ours alone; freezing it (and its rate) makes the table immutable for the process.
    if (parsed.data.rate) Object.freeze(parsed.data.rate)
    if (parsed.data.fallback?.rate) Object.freeze(parsed.data.fallback.rate)
    if (parsed.data.fallback) Object.freeze(parsed.data.fallback)
    out[id] = Object.freeze(parsed.data)
  }
  return Object.freeze(out)
}

/** The validated table, deeply frozen. Overrides never touch it. */
export const DEFAULT_ROUTES = build()
