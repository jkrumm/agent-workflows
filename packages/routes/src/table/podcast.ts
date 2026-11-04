import type { RouteEntry } from '../schema.ts'
import { CRITIC, EASY, HARD } from './_shared.ts'

// The podcast writers' room (audio `workflows/podcast`), one route per stage. Wave 6 eval picks
// (docs/evals/2026-11-02-claude-seats.md): the stages and the voice owner run on the HARD tier (Sonnet), the metadata on
// EASY (Haiku). Single calls and the writer's tool loop both speak the Messages wire. The reviewer stays on another
// lab (docs/gateway.md §Seats): Terra medium, never a Claude model. One reviewer model since 2026-11-04 (three role
// calls per round; the Gemini second opinion was dropped as overkill).

const routes = {
  'podcast.research': { wire: 'anthropic', ...HARD.call },
  'podcast.editorial': { wire: 'anthropic', ...HARD.call },
  'podcast.outline': { wire: 'anthropic', ...HARD.call },
  // The voice owner: every segment draft, revision and tightening pass.
  'podcast.write': { wire: 'anthropic', ...HARD.call },
  'podcast.review': { wire: 'iu-openai', ...CRITIC.call },
  'podcast.metadata': { wire: 'anthropic', ...EASY.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
