import type { RouteEntry } from '../schema.ts'
import { EASY, FAST, HARD } from './_shared.ts'

// Hermes' own model seats (owner, 2026-11-04: Hermes' model choices are central). Hermes calls the gateway itself and
// reads these through `agw routes` (model id, effort, output ceiling, fallback) when it renders its config, so a tier
// change in `_shared.ts` reaches Hermes without an edit there. agw never calls these routes. Each is a Claude tier on
// the Messages wire; the fallback is the tier's (GPT on IU, on a drained credit).
const routes = {
  // The conversation brain and its tool loop.
  'hermes.brain': { wire: 'anthropic', ...EASY.call },
  // Context compaction: summarize a long conversation.
  'hermes.compress': { wire: 'anthropic', ...EASY.call },
  // Conversation titles.
  'hermes.title': { wire: 'anthropic', ...FAST.call },
  // Tool-call approval: a yes/no classification.
  'hermes.approval': { wire: 'anthropic', ...FAST.call },
  // Image and screenshot reading.
  'hermes.vision': { wire: 'anthropic', ...HARD.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
