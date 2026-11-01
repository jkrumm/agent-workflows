import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, TRIVIAL } from './_shared.ts'

const routes = {
  // Image input for `image.read` (and so for `shop find --images`): one question about one picture, a short answer. The
  // seat is the cheapest text model that passed the 2026-11-01 probe on three product photos (`docs/shop.md` §Vision):
  // right shape, right count, no dimension invented where none is printed. The fallback is the other GPT model on the
  // chat wire (it takes images too, probed the same day), so a provider-balance failure moves the call instead of
  // ending it.
  'vision.describe': { wire: 'iu-openai', ...TRIVIAL, maxOutputTokens: 2_000, fallback: CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
