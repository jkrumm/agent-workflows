import type { RouteEntry } from '../schema.ts'
import { EASY, FAST } from './_shared.ts'

const routes = {
  // Software-factory's Classify station: project, kind, class, size, tier and effort of one Issue in one tool-free call.
  // The cheapest tier that passes the `factory-classify` eval (README §Route); the model is chosen once, in the tier.
  'factory.classify': { wire: 'anthropic', ...FAST.call },
  // Software-factory's check on a lead's `factory issue ask`: the owner's, or answerable from the plan or the declared
  // default. The cheapest tier, as the classifier; it has no eval set (owner decision).
  'factory.ask': { wire: 'anthropic', ...FAST.call },
  // Software-factory's steward: what a stalled Issue needs when the factory's own rules do not say (wake, requeue, or a
  // Decision). Haiku high, as the architecture names for the factory's judging loops; no eval set (owner decision).
  'factory.steward': { wire: 'anthropic', ...EASY.call },
  // Software-factory's triage: amend-or-new when the deterministic match is unsure, and the `after` edges of a new Issue.
  // Software-factory's queue loop: `after` edges and a tie-break order for a repo's queued Issues; the owner's `prio` stands.
  'factory.queue': { wire: 'anthropic', ...EASY.call },
  'factory.triage': { wire: 'anthropic', ...EASY.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
