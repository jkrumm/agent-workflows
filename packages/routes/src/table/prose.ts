import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, CHEAP, HAIKU_CALL_FALLBACK, WRITER } from './_shared.ts'

const routes = {
  // Prose review seat. Gateway: `prose_review` (SINGLE_SHOT, iu-openai). The reviewer must be a different lab than the
  // writer, and the writer is the calling Claude Code session (Anthropic): the capability refuses an Anthropic route.
  'prose.review': {
    wire: 'iu-openai',
    ...CHEAP,
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Prose writer seat, for callers with no Claude Code session (Hermes, `narrative`). Gateway: `prose_write` was Opus 5.5
  // on the native Messages wire. Owner direction 2026-10-30: nothing here spends on an expensive model while the team key
  // pays, and Terra at medium effort writes better prose than DeepSeek flash. Terra on the OpenAI chat wire; the fallback is
  // Haiku (Terra would fall back to itself), as on `review.adversary`. Claude Code sessions rewrite in the session on Max and
  // never call this route.
  'prose.write': {
    wire: 'iu-openai',
    ...WRITER,
    fallback: HAIKU_CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
