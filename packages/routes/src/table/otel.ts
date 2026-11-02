import type { RouteEntry } from '../schema.ts'
import { HARD } from './_shared.ts'

const routes = {
  // Otel agent (concept N7): one session querying HyperDX through the tool gate. Moved from DeepSeek flash to the HARD
  // tier (Sonnet) in Wave 6 (docs/evals/2026-11-02-claude-seats.md).
  'otel.agent': { wire: 'opencode', ...HARD.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
