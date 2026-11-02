import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // Diagram agent (Wave 7): one read-only session that answers the Excalidraw skeleton JSON; the host hydrates it in
  // code. Wave 6 eval pick: the FAST tier (Haiku, no thinking), docs/evals/2026-11-02-claude-seats.md.
  'diagram.agent': { wire: 'opencode', ...FAST.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
