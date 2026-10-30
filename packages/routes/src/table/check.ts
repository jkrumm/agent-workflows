import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, FAST } from './_shared.ts'

const routes = {
  // Check seat. Gateway: `check`, CLASSIFY tier.
  check: { wire: 'opencode', ...FAST, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
