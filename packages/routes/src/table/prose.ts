import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK } from './_shared.ts'

// Opus 5.5, USD/M: in 4.00, out 20.00, cache read 0.20 (0.05x in), cache write 5.00 (5-minute, 1.25x in); agent-gateway
// `server/lib/models.ts` (modelpick metric snapshot, 2026-10-17), the rate its `prose_write` seat priced with. The IU
// Messages response carries no `usage.cost`, so the route carries the rate.
const OPUS_55_RATE = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 }

const routes = {
  // Prose review seat. Gateway: `prose_review` (SINGLE_SHOT, iu-openai). The reviewer must be a different lab than the
  // writer, and the writer is the calling Claude Code session (Anthropic): the capability refuses an Anthropic route.
  'prose.review': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Prose writer seat, for callers with no Claude Code session (Hermes, `narrative`). Gateway: `prose_write`
  // (iu-anthropic, one native Messages call, Opus 5.5 with adaptive thinking at effort high and a 32k ceiling; owner
  // decision 2026-10-17, modelpick `bench:writing`). `claude-opus-5-5` is listed on IU's `/models` (probed 2026-10-29).
  // Claude Code sessions rewrite in the session on Max and never call this route. The gateway seat had no fallback; the
  // shared balance fallback applies to every IU route (concept v3.3).
  'prose.write': {
    wire: 'iu-anthropic',
    model: 'claude-opus-5-5',
    effort: 'high',
    maxOutputTokens: 32_000,
    rate: OPUS_55_RATE,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
