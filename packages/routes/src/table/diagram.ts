import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // Diagram agent seat (Wave 7): one read-only session that answers the Excalidraw skeleton JSON; the host hydrates it in
  // code. Judgment about layout and what to draw: the STRONG seat (Sonnet).
  'diagram.agent': { wire: 'opencode', ...STRONG, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
