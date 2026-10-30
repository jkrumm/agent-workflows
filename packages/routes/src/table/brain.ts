import type { RouteEntry } from '../schema.ts'
import { PRIVATE } from './_shared.ts'

const routes = {
  // Brain agent seat (Wave 7): read-only Q&A over the owner's private vault (health, finance, personal notes) through
  // the tool gate. The notes never leave Anthropic's EU leg, so this seat stays off the GPT stack and has NO fallback (lead
  // decision, Wave 7): a provider-balance failure fails the run with the typed error instead of moving to another
  // provider. `AGW_ROUTES` cannot add one (a route without a fallback cannot gain one).
  'brain.agent': { wire: 'opencode', ...PRIVATE },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
