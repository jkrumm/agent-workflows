import type { RouteEntry } from '../schema.ts'
import { LUNA_CALL_FALLBACK, TRIVIAL } from './_shared.ts'

const routes = {
  // `agw digest`: short texts for a batch of items in one tool-free call. The cheapest seat that passes the `digest` eval
  // (the workflow's README §Route); the model is chosen once, in the seat. 64 answers fit well inside 16 000 output tokens.
  'digest.items': { wire: 'anthropic', ...TRIVIAL, maxOutputTokens: 16_000, fallback: LUNA_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
