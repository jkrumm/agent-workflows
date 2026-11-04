import type { RouteEntry } from '../schema.ts'
import { VISION } from './_shared.ts'

const routes = {
  // Image input for `image.read` (and so for `shop find --images`): one question about one picture, a short answer. The
  // seat is `VISION` (_shared.ts): the cheapest text model that passed the 2026-11-01 probe on three product photos
  // (`docs/shop.md` §Vision), with the other GPT model as the provider-balance fallback.
  'vision.describe': { wire: 'iu-openai', ...VISION.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
