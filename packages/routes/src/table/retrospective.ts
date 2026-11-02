import type { RouteEntry } from '../schema.ts'
import { HARD } from './_shared.ts'

const routes = {
  // Retrospective (concept §7): one agent step over sampled run records, JSON out. It finds patterns: the HARD tier (Sonnet).
  'retro.analyze': { wire: 'opencode', ...HARD.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
