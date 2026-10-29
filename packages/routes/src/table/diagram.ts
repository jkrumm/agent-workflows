import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, HAIKU_55_RATE } from './_shared.ts'

const routes = {
  // Diagram agent seat (Wave 7): agent-gateway's `excalidraw_diagram` ran Haiku 5.5 on OpenCode after its Wave 10
  // bench (23-30 s, $0.003-0.005, 26-27 elements per diagram; Sonnet 111-121 s, $0.13). One read-only session that
  // answers the skeleton JSON; the host hydrates it in code. Same model and wire as `check`.
  'diagram.agent': { wire: 'opencode', model: 'claude-haiku-5-5', rate: HAIKU_55_RATE, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
