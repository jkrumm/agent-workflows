import type { RouteEntry } from '../schema.ts'
import { DEEPSEEK_FLASH } from './_shared.ts'

const routes = {
  // Otel agent (concept N7): one session querying HyperDX through the tool gate. Same model, wire and rate as
  // `research.agent` (a tool loop over the same re-sent context); agent-gateway ran it as Sonnet on Max. The eval
  // rule (docs/research/2026-10-29-wave7-ports.md) arms the HARD tier's Sonnet through a route override if this fails.
  'otel.agent': { wire: 'opencode', ...DEEPSEEK_FLASH.agent, maxOutputTokens: 16_000 },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
