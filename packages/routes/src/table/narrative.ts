import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // The narrative page writer. Gateway: `narrative`. One JSON request: the page sections written from the gathered facts.
  // Editorial output: the STRONG seat (Sonnet) on the native Messages wire; the route carries the rate.
  narrative: { wire: 'anthropic', ...STRONG, fallback: CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
