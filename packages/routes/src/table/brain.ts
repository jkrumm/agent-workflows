import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Brain agent (Wave 7): read-only Q&A over the owner's private vault (health, finance, personal notes) through
  // the tool gate: a handful of short tool calls per question, the EASY tier (Haiku). It was Haiku 5.5 on Anthropic's EU leg
  // with NO fallback, so the notes never left one provider; the owner dropped that constraint (2026-10-30: residency is
  // not a concern), so a drained credit falls back to Terra low on IU (2026-11-01).
  'brain.agent': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
