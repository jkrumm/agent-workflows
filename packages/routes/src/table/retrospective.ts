import type { RouteEntry } from '../schema.ts'
import { OPENAI_AGENT_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // Retrospective seat (concept §7): one agent step over sampled run records, JSON out. It finds patterns: Terra medium.
  'retro.analyze': { wire: 'opencode', ...STRONG, fallback: OPENAI_AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
