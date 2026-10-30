import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, FAST } from './_shared.ts'

const routes = {
  // The narrative page writer. Gateway: `narrative` (CLASSIFY tier, a tool-less Haiku 5.5 session on OpenCode over IU).
  // The platform asks for the same JSON as one native Messages request to the same model; the model exposes no effort.
  // IU's Messages response carries no `usage.cost`, so the route carries the rate.
  narrative: {
    wire: 'iu-anthropic',
    ...FAST,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
