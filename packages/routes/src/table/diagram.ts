import type { RouteEntry } from '../schema.ts'
import { HARD } from './_shared.ts'

const routes = {
  // Diagram agent (Wave 7): one read-only session that answers the Excalidraw skeleton JSON; the host hydrates it in
  // code. Judgment about layout and what to draw: the HARD tier (Sonnet).
  'diagram.agent': { wire: 'opencode', ...HARD.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
