import type { RouteEntry } from '../schema.ts'
import { OPENAI_CALL_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // The narrative page writer. Gateway: `narrative`. One JSON request: the page sections written from the gathered facts.
  // Editorial output: Terra medium. IU's chat response carries no `usage.cost` here, so the route carries the rate.
  narrative: { wire: 'iu-openai', ...STRONG, fallback: OPENAI_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
