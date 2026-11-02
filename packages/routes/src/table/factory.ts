import type { RouteEntry } from '../schema.ts'
import { OPENAI_CALL_FALLBACK, TRIVIAL } from './_shared.ts'

const routes = {
  // Software-factory's Classify station: project, kind, class, size, tier and effort of one Issue in one tool-free call.
  // The cheapest seat that passes the `factory-classify` eval (README §Route); the model is chosen once, in the seat.
  'factory.classify': { wire: 'iu-openai', ...TRIVIAL, fallback: OPENAI_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
