import type { RouteEntry } from '../schema.ts'
import { EASY, LUNA_CALL_FALLBACK, TERRA_LOW_CALL_FALLBACK, TRIVIAL } from './_shared.ts'

const routes = {
  // Single-call seats on Claude (owner decision 2026-11-01): the native Messages wire on the gateway, which pays from the
  // credit. A label needs no judgment (TRIVIAL, Haiku without thinking); a summary or an extraction needs a clear read
  // (EASY, Haiku high). `title` shares the label seat. A drained credit is a 402 and the call moves to GPT on IU's chat
  // wire: Luna low for a label, Terra low for a summary or an extraction. The routes carry the rate.
  'cheap.classify': { wire: 'anthropic', ...TRIVIAL, fallback: LUNA_CALL_FALLBACK },
  'cheap.summarize': { wire: 'anthropic', ...EASY, fallback: TERRA_LOW_CALL_FALLBACK },
  'cheap.extract': { wire: 'anthropic', ...EASY, fallback: TERRA_LOW_CALL_FALLBACK },
  'cheap.title': { wire: 'anthropic', ...TRIVIAL, fallback: LUNA_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
