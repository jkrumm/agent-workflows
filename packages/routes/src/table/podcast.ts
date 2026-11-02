import type { RouteEntry } from '../schema.ts'
import { DEEPSEEK_FLASH, GEMINI_FLASH, VOICE } from './_shared.ts'

// The podcast writers' room (audio `workflows/podcast`), one route per stage. Defaults are audio-gateway's
// (`src/config.ts`, 2026-10-29): research, editorial, outline and metadata on DeepSeek flash at effort high; the reviewer
// roster is Gemini flash and DeepSeek flash (each of the three roles runs on each); the voice owner is DeepSeek flash
// too (owner direction 2026-10-30: no expensive model on the team key; it was GPT-6.1 Sol, owner decision 2026-10-26).

// Every stage is a cross-lab seat (`_shared.ts`), not a tier: they stay off Claude until the eval picks move them.
const flashStage = { wire: 'iu-openai', ...DEEPSEEK_FLASH.call, effort: 'high' } as const

const routes = {
  'podcast.research': flashStage,
  'podcast.editorial': flashStage,
  'podcast.outline': flashStage,
  // The voice owner: every segment draft, revision and tightening pass. It stays on GPT (the VOICE constant, Terra medium at
  // effort high) and not on the HARD tier (Sonnet): `Llm.round`, the writer's tool loop, speaks only the OpenAI dialects
  // (`packages/audio/src/workflows/podcast/iu.ts`), so any route used through it must sit on `iu-openai`. On a
  // provider-balance failure it falls back to DeepSeek flash, the other lab, as it did before the tiers.
  'podcast.write': { wire: 'iu-openai', ...VOICE.call },
  // No effort on the Gemini reviewer: its OpenAI-compatible leg rejects `reasoning_effort`.
  'podcast.review.a': { wire: 'iu-openai', ...GEMINI_FLASH.call },
  'podcast.review.b': flashStage,
  'podcast.metadata': flashStage,
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
