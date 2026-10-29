import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, HAIKU_55_EU_RATE } from './_shared.ts'

const routes = {
  // Check seat. Gateway: `check`, CLASSIFY tier.
  check: { wire: 'opencode', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
