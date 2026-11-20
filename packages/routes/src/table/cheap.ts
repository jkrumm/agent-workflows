import type { RouteEntry } from '../schema.ts'
import { EASY, FAST } from './_shared.ts'

const routes = {
  // Single calls on Claude (owner decision 2026-11-01): the native Messages wire on the gateway, which pays from the
  // credit. A label or a title needs no judgment (the FAST tier, Haiku without thinking); a summary or an extraction needs a clear read
  // (the EASY tier, Haiku high). `title` shares the label tier. A drained credit is a 402 and the call moves to GPT on IU's chat
  // wire: Luna low for a label, Terra low for a summary or an extraction. The tiers carry the rate and the fallback.
  // An extraction at effort none or low halves the wall time but loses completeness (-0.3 to -0.4 of 5, faithfulness
  // unchanged): docs/evals/2026-11-16-effort-arms.md. It stays on the EASY tier until that trade is taken on purpose.
  // A summary at effort low or none keeps its point but ignores a word bound (iris's 30-word gist fits it in 96 % of runs at
  // high, 46 % at medium, 0 % at low): docs/evals/2026-11-20-iris-effort-arms.md.
  'cheap.summarize': { wire: 'anthropic', ...EASY.call },
  'cheap.extract': { wire: 'anthropic', ...EASY.call },
  'cheap.title': { wire: 'anthropic', ...FAST.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
