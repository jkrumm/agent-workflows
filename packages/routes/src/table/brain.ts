import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // Brain agent seat (Wave 7): read-only Q&A over the owner's private vault (health, finance, personal notes) through
  // the tool gate. Haiku 5.5 rather than DeepSeek, and NO fallback (lead decision, Wave 7): the notes it reads
  // never leave Anthropic, so a provider-balance failure fails the run with the typed error instead of
  // moving to another provider. `AGW_ROUTES` cannot add one (a route without a fallback cannot gain one). Same model,
  // wire and rate as `check`; a handful of short tool calls per question.
  'brain.agent': { wire: 'opencode', ...FAST },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
