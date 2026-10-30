import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, CHEAP } from './_shared.ts'

const routes = {
  // Research agent seat (concept P3): research-gateway's lead and worker model, the same model as `review.adversary`.
  // Single calls on this model are priced by IU's `usage.cost`; an OpenCode session never sees that field and prices
  // each message with the config's cost rows, so the route carries the rate IU's `usage.cost` was measured at:
  // USD/M in 0.30, cache read 0.006, out 1.20 (research-gateway src/lib/cost.ts, the 2026-09-25 peak reading, its
  // conservative row; an off-peak reading was half). No cache-write price: DeepSeek reports none.
  'research.agent': {
    wire: 'opencode',
    ...CHEAP,
    maxOutputTokens: 16_000,
    fallback: AGENT_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
