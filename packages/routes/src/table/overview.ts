import type { RouteEntry } from '../schema.ts'
import { EASY, OPENAI_CALL_FALLBACK } from './_shared.ts'

const routes = {
  // Overview seat. Gateway: `overview`, CLASSIFY tier: one batched prompt-only call that classifies the fleet's items.
  // Nothing routes via Requesty, no region is pinned (owner direction 2026-10-29). Easy, clear shape: Terra low.
  'overview.classify': { wire: 'iu-openai', ...EASY, fallback: OPENAI_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
