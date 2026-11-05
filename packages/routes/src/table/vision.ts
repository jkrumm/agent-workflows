import type { RouteEntry } from '../schema.ts'
import { VISION } from './_shared.ts'

const routes = {
  // Image input for `image.read` (and so for `shop find --images`): one question about one picture, a short answer. The
  // seat is `VISION` (_shared.ts): Haiku on the Messages wire, with Luna on the chat wire as the provider-balance
  // fallback; both were probed on three product photos (`docs/shop.md` §Vision).
  'vision.describe': { wire: 'anthropic', ...VISION.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
