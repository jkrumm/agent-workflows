import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // Software-factory's Classify station: project, kind, class, size, tier and effort of one Issue in one tool-free call.
  // The cheapest tier that passes the `factory-classify` eval (README §Route); the model is chosen once, in the tier.
  'factory.classify': { wire: 'anthropic', ...FAST.call },
  // Software-factory's check on a lead's `factory issue ask`: the owner's, or answerable from the plan or the declared
  // default. The cheapest tier, as the classifier; it has no eval set (owner decision).
  'factory.ask': { wire: 'anthropic', ...FAST.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
