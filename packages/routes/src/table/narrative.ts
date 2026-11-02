import type { RouteEntry } from '../schema.ts'
import { HARD } from './_shared.ts'

const routes = {
  // The narrative page writer. Gateway: `narrative`. One JSON request: the page sections written from the gathered facts.
  // Editorial output: the HARD tier (Sonnet) on the native Messages wire.
  narrative: { wire: 'anthropic', ...HARD.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
