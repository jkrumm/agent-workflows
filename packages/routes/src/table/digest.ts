import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // `agw digest`: short texts for a batch of items in one tool-free call. The cheapest tier that passes the `digest` eval
  // (the workflow's README §Route); the model is chosen once, in the tier. FAST's 16 000 ceiling fits 64 answers.
  'digest.items': { wire: 'anthropic', ...FAST.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
