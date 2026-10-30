import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK } from './_shared.ts'

// The podcast writers' room (audio `workflows/podcast`), one route per stage. Defaults are audio-gateway's
// (`src/config.ts`, 2026-10-29): research, editorial, outline and metadata on DeepSeek flash at effort high; the reviewer
// roster is Gemini flash and DeepSeek flash (each of the three roles runs on each); the voice owner is DeepSeek flash
// too (owner direction 2026-10-30: no expensive model on the team key; it was GPT-6.1 Sol, owner decision 2026-10-26).

// DeepSeek flash, USD/M: in 0.30, cache read 0.006, out 1.20, the rate `research.agent` carries (research-gateway's
// conservative 2026-09-25 reading). IU's `usage.cost` wins on single calls; the rate prices a call that lacks it.
const DEEPSEEK_FLASH_RATE = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }
// Gemini 3.8 Flash, USD/M: in 0.75, out 3.75 (introductory through 2026-12-31, then 1.50 / 7.50), audio-gateway
// `src/usage.ts`. No cache rate: a call reporting cache reads without `usage.cost` is priced `unknown`, never 0.
const GEMINI_FLASH_RATE = { inputPerM: 0.75, outputPerM: 3.75 }
const cheapSeat = {
  wire: 'iu-openai',
  model: 'deepseek-v4.1-flash',
  effort: 'high',
  rate: DEEPSEEK_FLASH_RATE,
  fallback: CALL_FALLBACK,
} as const

const routes = {
  'podcast.research': cheapSeat,
  'podcast.editorial': cheapSeat,
  'podcast.outline': cheapSeat,
  // The voice owner: every segment draft, revision and tightening pass. The shared balance fallback (concept v3.3, every
  // IU route has one) applies only when IU refuses for provider balance.
  'podcast.write': cheapSeat,
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
