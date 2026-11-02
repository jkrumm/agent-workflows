import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Check. Gateway: `check`, CLASSIFY tier. Runs the repo's checks and reports the failures: an easy read (the EASY tier).
  check: { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
