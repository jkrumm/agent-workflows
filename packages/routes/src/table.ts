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

const TABLE = {
  // Cheap single-shot seats. Gateway: SINGLE_SHOT (triage) over the iu-openai transport.
  // single-shot.ts sends max_completion_tokens >= 16000, because reasoning tokens count against it.
  'cheap.classify': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  // Gateway: CLASSIFY tier (overview, narrative), a Haiku 5.5 EU session on OpenCode. The platform
  // calls it as one native Messages request; the model is unchanged. The model exposes no effort.
  'cheap.summarize': { wire: 'iu-anthropic', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },
  'cheap.title': { wire: 'iu-anthropic', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },

  // IU decision API. Gateway: DEFAULT_DECISION_MODEL; rates are the UE price list in decision.ts.
  decide: { wire: 'iu-decision', model: 'pplx-decider-v1-27b', rate: { inputPerM: 0.04, outputPerM: 0.04 } },

  // Review seats. Gateway: review_router is SINGLE_SHOT; adversary is deepseek-v4.1-flash on iu-openai.
  'review.router': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  'review.adversary': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry)
  // and `review` (synthesis, CLASSIFY tier), both Haiku 5.5 EU on the OpenCode harness.
  'review.angle': { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },
  'review.synthesis': { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },

  // Check seat. Gateway: `check`, CLASSIFY tier.
  check: { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },
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
    out[id] = Object.freeze(parsed.data)
  }
  return Object.freeze(out)
}

/** The validated table, deeply frozen. Overrides never touch it. */
export const DEFAULT_ROUTES = build()
