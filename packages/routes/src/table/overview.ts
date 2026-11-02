import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Overview. Gateway: `overview`, CLASSIFY tier: one batched prompt-only call that classifies the fleet's items.
  // Nothing routes via Requesty, no region is pinned (owner direction 2026-10-29). Easy, clear shape: the EASY tier (Haiku high).
  'overview.classify': { wire: 'anthropic', ...EASY.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
