import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // Image input for `image.read` (and so for `shop find --images`): one question about one picture, a short answer. It
  // spreads the FAST tier like any Claude route (Haiku on the Messages wire, Luna on the chat wire as the
  // provider-balance fallback; both take pictures). The pick and its measured limit: `docs/shop.md` §Vision.
  'vision.describe': { wire: 'anthropic', ...FAST.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
