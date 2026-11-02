import type { RouteEntry } from '../schema.ts'
import { EASY, FAST } from './_shared.ts'

const routes = {
  // Single calls on Claude (owner decision 2026-11-01): the native Messages wire on the gateway, which pays from the
  // credit. A label needs no judgment (the FAST tier, Haiku without thinking); a summary or an extraction needs a clear read
  // (the EASY tier, Haiku high). `title` shares the label tier. A drained credit is a 402 and the call moves to GPT on IU's chat
  // wire: Luna low for a label, Terra low for a summary or an extraction. The tiers carry the rate and the fallback.
  'cheap.classify': { wire: 'anthropic', ...FAST.call },
  'cheap.summarize': { wire: 'anthropic', ...EASY.call },
  'cheap.extract': { wire: 'anthropic', ...EASY.call },
  'cheap.title': { wire: 'anthropic', ...FAST.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
