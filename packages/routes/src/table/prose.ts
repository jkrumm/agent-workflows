import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK } from './_shared.ts'

const routes = {
  // Prose review seat. Gateway: `prose_review` (SINGLE_SHOT, iu-openai). The reviewer must be a different lab than the
  // writer, and the writer is the calling Claude Code session (Anthropic): the capability refuses an Anthropic route.
  'prose.review': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
