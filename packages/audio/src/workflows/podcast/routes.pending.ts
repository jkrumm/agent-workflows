import { DEFAULT_ROUTES, type ResolvedRoute, type RouteEntry, routeSchema } from '../../../../routes/src/index.ts'

// PENDING REGISTRATION. The podcast's routes, one per stage, until the registry PR splits the route table and the lead
// says where they go; then this file moves into the table verbatim and `resolvePodcastRoute` becomes `resolveRoute`
// (which also applies `AGW_ROUTES`; until then no override reaches these routes).
//
// The cheap seats run the model of the platform's `cheap.classify` seat, referenced instead of named because a model
// id the table already holds may appear nowhere else (routes `guard.test.ts`); on registration the reference becomes
// the literal id. Legacy defaults (audio-gateway `src/config.ts`): research, editorial, outline and metadata on that
// model at effort high; the reviewer roster is one Gemini flash and that model; the voice owner is the GPT-6.1 Sol
// writer, its documented rollback the Opus 5.5 entry at the bottom (native Anthropic Messages wire).
const CHEAP = DEFAULT_ROUTES['cheap.classify']
// The platform's measured rate for that model when IU's `usage.cost` is missing (routes `table.ts`, `research.agent`).
const CHEAP_RATE = DEFAULT_ROUTES['research.agent'].rate

// GPT-6.1 Sol, USD/M: in 2.00, cached in 0.10, out 10.00. PROVISIONAL, carried from audio-gateway `src/usage.ts`
// ("search-snippet level only, research 2026-10-26"). IU's `usage.cost` wins where the wire sends it.
const SOL_RATE = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 }
// Gemini 3.8 Flash, USD/M: in 0.75, out 3.75 (introductory through 2026-12-31, then 1.50 / 7.50), from audio-gateway
// `src/usage.ts`. No cache rate: a call reporting cache reads without `usage.cost` is priced `unknown`, never 0.
const GEMINI_FLASH_RATE = { inputPerM: 0.75, outputPerM: 3.75 }
// Opus 5.5, USD/M: in 4.00, out 20.00, cache read 0.20 (0.05x in), cache write 5.00 (5-minute, 1.25x in); audio-gateway
// `src/usage.ts` (agent-gateway models.ts, 2026-10-17). The Messages wire carries no `usage.cost`.
const OPUS_RATE = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, longPromptTokens: 1_000_000 }

const cheapSeat: RouteEntry = {
  wire: 'iu-openai',
  model: CHEAP.model,
  effort: 'high',
  ...(CHEAP_RATE ? { rate: CHEAP_RATE } : {}),
  ...(CHEAP.fallback ? { fallback: CHEAP.fallback } : {}),
}

export const PODCAST_ROUTES = {
  // The research tool loop: brain, past episodes, the host's `research` workflow.
  'podcast.research': cheapSeat,
  // One call: the episode brief.
  'podcast.editorial': cheapSeat,
  // One call: the story outline.
  'podcast.outline': cheapSeat,
  // The voice owner: every segment draft, revision and tightening pass, agentic loop and single-shot fallback. Its
  // function tools are served on IU's `/v1/responses` only (llm.ts `usesResponsesApi`). No fallback: the voice never
  // moves to another model silently.
  'podcast.write': { wire: 'iu-openai', model: 'gpt-6.1-sol', effort: 'high', rate: SOL_RATE },
  // The reviewer roster: each of the three roles runs on each of these, in parallel. No effort on the Gemini seat (its
  // OpenAI-compatible leg rejects `reasoning_effort`).
  'podcast.review.a': { wire: 'iu-openai', model: 'gemini-3.8-flash', rate: GEMINI_FLASH_RATE },
  'podcast.review.b': cheapSeat,
  // One call: final title, description, cover prompt, genres, topics, chapter titles.
  'podcast.metadata': cheapSeat,
} as const satisfies Record<string, RouteEntry>

// Rollback of `podcast.write` (owner decision 2026-10-26 kept it one line away): replace the entry with
//   'podcast.write': { wire: 'iu-anthropic', model: 'claude-opus-5-5', effort: 'high', rate: OPUS_RATE },
// The single-shot writer then speaks the native Messages wire (adaptive thinking, `output_config.effort`, the segment
// schema as `output_config.format`, the cached system prefix); the agentic loop stays on IU's OpenAI dialect, which
// serves Claude's tools. `OPUS_RATE` stays defined for that line.
export const ROLLBACK_WRITER_RATE = OPUS_RATE

export type PodcastRouteId = keyof typeof PODCAST_ROUTES

/** The validated entry for a podcast route id. */
export function resolvePodcastRoute(id: PodcastRouteId): ResolvedRoute {
  const parsed = routeSchema.safeParse(PODCAST_ROUTES[id])
  if (!parsed.success) throw new Error(`podcast route "${id}" is invalid: ${parsed.error.message}`)
  return { id, ...structuredClone(parsed.data) }
}
