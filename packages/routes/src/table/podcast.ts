import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK } from './_shared.ts'

// The podcast writers' room (audio `workflows/podcast`), one route per stage. Defaults are audio-gateway's
// (`src/config.ts`, 2026-10-29): research, editorial, outline and metadata on DeepSeek flash at effort high; the reviewer
// roster is Gemini flash and DeepSeek flash (each of the three roles runs on each); the voice owner is GPT-6.1 Sol
// (owner decision 2026-10-26, the blind writer rematch), its function tools served on IU's `/v1/responses` only.

// DeepSeek flash, USD/M: in 0.30, cache read 0.006, out 1.20, the rate `research.agent` carries (research-gateway's
// conservative 2026-09-25 reading). IU's `usage.cost` wins on single calls; the rate prices a call that lacks it.
const DEEPSEEK_FLASH_RATE = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }
// GPT-6.1 Sol, USD/M: in 2.00, cached in 0.10, out 10.00. PROVISIONAL, carried from audio-gateway `src/usage.ts`
// ("search-snippet level only, research 2026-10-26"). IU's `usage.cost` wins where the wire sends it.
const SOL_RATE = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 }
// Gemini 3.8 Flash, USD/M: in 0.75, out 3.75 (introductory through 2026-12-31, then 1.50 / 7.50), audio-gateway
// `src/usage.ts`. No cache rate: a call reporting cache reads without `usage.cost` is priced `unknown`, never 0.
const GEMINI_FLASH_RATE = { inputPerM: 0.75, outputPerM: 3.75 }
// Opus 5.5, USD/M: in 4.00, out 20.00, cache read 0.20 (0.05x in), cache write 5.00 (5-minute, 1.25x in); audio-gateway
// `src/usage.ts` (agent-gateway models.ts, 2026-10-17). For the writer's rollback below.
export const OPUS_55_RATE = {
  inputPerM: 4,
  outputPerM: 20,
  cacheReadPerM: 0.2,
  cacheWritePerM: 5,
  longPromptTokens: 1_000_000,
}

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
  // IU route has one) applies only when IU refuses for provider balance. Rollback (one line, documented in the
  // workflow README):
  //   'podcast.write': { wire: 'iu-anthropic', model: 'claude-opus-5-5', effort: 'high', rate: OPUS_55_RATE },
  // The single-shot writer then speaks the native Messages wire; the agentic loop stays on IU's OpenAI dialect.
  'podcast.write': { wire: 'iu-openai', model: 'gpt-6.1-sol', effort: 'high', rate: SOL_RATE, fallback: CALL_FALLBACK },
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
