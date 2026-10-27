import { ROUTE_ID, type RouteEntry, routeSchema } from './schema.ts'

// The only place model ids live in this repo (concept §4, §5; enforced by guard.test.ts).
// Each entry's model and effort are what agent-gateway's server/lib/routing.ts resolves today
// (`GET /api/routing`, 2026-10-27). The README lists the source seat of every route.
const TABLE = {
  // Cheap single-shot seats. Gateway: SINGLE_SHOT (triage) over the iu-openai transport.
  // single-shot.ts sends max_completion_tokens >= 16000, because reasoning tokens count against it.
  'cheap.classify': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  // Gateway: CLASSIFY tier (overview, narrative), a Haiku 5.5 EU session on OpenCode. The platform
  // calls it as one native Messages request; the model is unchanged. The model exposes no effort.
  'cheap.summarize': { wire: 'iu-anthropic', model: 'claude-haiku-5-5-eu' },
  'cheap.title': { wire: 'iu-anthropic', model: 'claude-haiku-5-5-eu' },

  // IU decision API. Gateway: DEFAULT_DECISION_MODEL; rates are the UE price list in decision.ts.
  decide: { wire: 'iu-decision', model: 'pplx-decider-v1-27b', rate: { inputPerM: 0.04, outputPerM: 0.04 } },

  // Review seats. Gateway: review_router is SINGLE_SHOT; adversary is deepseek-v4.1-flash on iu-openai.
  'review.router': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  'review.adversary': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', maxOutputTokens: 16_000 },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry)
  // and `review` (synthesis, CLASSIFY tier), both Haiku 5.5 EU on the OpenCode harness.
  'review.angle': { wire: 'opencode', model: 'claude-haiku-5-5-eu' },
  'review.synthesis': { wire: 'opencode', model: 'claude-haiku-5-5-eu' },

  // Check seat. Gateway: `check`, CLASSIFY tier.
  check: { wire: 'opencode', model: 'claude-haiku-5-5-eu' },
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
