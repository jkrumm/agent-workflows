import type { RouteEntry } from '../schema.ts'
import { EASY, OPENAI_AGENT_FALLBACK } from './_shared.ts'

const routes = {
  // Check seat. Gateway: `check`, CLASSIFY tier. Runs the repo's checks and reports the failures: an easy read (Terra low).
  check: { wire: 'opencode', ...EASY, fallback: OPENAI_AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
