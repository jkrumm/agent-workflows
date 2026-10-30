import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, CHEAP, OPENAI_CALL_FALLBACK, STRONG } from './_shared.ts'

// The podcast writers' room (audio `workflows/podcast`), one route per stage. Defaults are audio-gateway's
// (`src/config.ts`, 2026-10-29): research, editorial, outline and metadata on DeepSeek flash at effort high; the reviewer
// roster is Gemini flash and DeepSeek flash (each of the three roles runs on each); the voice owner is DeepSeek flash
// too (owner direction 2026-10-30: no expensive model on the team key; it was GPT-6.1 Sol, owner decision 2026-10-26).

// Gemini 3.8 Flash, USD/M: in 0.75, out 3.75 (introductory through 2026-12-31, then 1.50 / 7.50), audio-gateway
// `src/usage.ts`. No cache rate: a call reporting cache reads without `usage.cost` is priced `unknown`, never 0.
const GEMINI_FLASH_RATE = { inputPerM: 0.75, outputPerM: 3.75 }
const cheapSeat = {
  wire: 'iu-openai',
  ...CHEAP,
  effort: 'high',
  fallback: CALL_FALLBACK,
} as const

const routes = {
  'podcast.research': cheapSeat,
  'podcast.editorial': cheapSeat,
  'podcast.outline': cheapSeat,
  // The voice owner: every segment draft, revision and tightening pass. The shared balance fallback (concept v3.3, every
  // IU route has one) applies only when IU refuses for provider balance.
  'podcast.write': { wire: 'iu-openai', ...STRONG, effort: 'high', fallback: OPENAI_CALL_FALLBACK },
  // No effort on the Gemini seat: its OpenAI-compatible leg rejects `reasoning_effort`.
  'podcast.review.a': {
    wire: 'iu-openai',
    model: 'gemini-3.8-flash',
    rate: GEMINI_FLASH_RATE,
    fallback: CALL_FALLBACK,
  },
  'podcast.review.b': cheapSeat,
  'podcast.metadata': cheapSeat,
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
