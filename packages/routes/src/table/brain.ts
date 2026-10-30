import type { RouteEntry } from '../schema.ts'
import { EASY, OPENAI_AGENT_FALLBACK } from './_shared.ts'

const routes = {
  // Brain agent seat (Wave 7): read-only Q&A over the owner's private vault (health, finance, personal notes) through
  // the tool gate: a handful of short tool calls per question, Terra low. It was Haiku 5.5 on Anthropic's EU leg with NO
  // fallback, so the notes never left one provider; the owner dropped that constraint (2026-10-30: residency is not a
  // concern, Haiku is off the platform), so it now falls back to the other lab like every GPT route.
  'brain.agent': { wire: 'opencode', ...EASY, fallback: OPENAI_AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
