import type { RouteEntry } from '../schema.ts'

const routes = {
  // IU decision API. Gateway: DEFAULT_DECISION_MODEL = pplx-decider-v1-27b, which IU serves through its "Requesty decision
  // compatibility API" (response header x-middleware-forwarded-server, probed 2026-10-29). Owner direction: nothing
  // routes via Requesty and no region is pinned, so this is `decision-1` (Microsoft; header "Global Sink Sweden Decisions
  // API", probed 2026-10-29: 200, the same `microsoft-decision-1` model the region-pinned twin serves from the
  // "GDPR Sink"): same wire and request shape, same 60k-character cap. Rate: the UE price list in the gateway's
  // decision.ts, input only ($0.042/M, output $0).
  decide: { wire: 'iu-decision', model: 'decision-1', rate: { inputPerM: 0.042, outputPerM: 0 } },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
