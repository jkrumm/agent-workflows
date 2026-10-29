import type { RouteEntry } from '../schema.ts'

const routes = {
  // IU decision API. Gateway: DEFAULT_DECISION_MODEL; rates are the UE price list in decision.ts.
  decide: { wire: 'iu-decision', model: 'pplx-decider-v1-27b', rate: { inputPerM: 0.04, outputPerM: 0.04 } },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
