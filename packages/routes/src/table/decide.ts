import type { RouteEntry } from '../schema.ts'
import { DECIDE } from './_shared.ts'

const routes = {
  // IU decision API, the DECIDE tier (`_shared.ts`: model, provenance and rate). Gateway: `decide`.
  decide: { wire: 'iu-decision', ...DECIDE.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
