import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // `agw digest`: short texts for a batch of items in one tool-free call. The cheapest tier that passes the `digest` eval
  // (the workflow's README §Route); the model is chosen once, in the tier. 64 answers fit well inside 16 000 output tokens.
  'digest.items': { wire: 'anthropic', ...FAST.call, maxOutputTokens: 16_000 },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
