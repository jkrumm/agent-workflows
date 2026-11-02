import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // Retrospective seat (concept §7): one agent step over sampled run records, JSON out. It finds patterns: the STRONG seat (Sonnet).
  'retro.analyze': { wire: 'opencode', ...STRONG, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
