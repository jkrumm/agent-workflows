import type { RouteEntry } from '../schema.ts'
import { DEEPSEEK_FLASH, HARD } from './_shared.ts'

const routes = {
  // Prose review. Gateway: `prose_review` (SINGLE_SHOT, iu-openai). The reviewer must be a different lab than the
  // writer, and the writer is the calling Claude Code session (Anthropic): the capability refuses an Anthropic route (a
  // Claude model, or any wire but `iu-openai`), so this route stays on the DEEPSEEK_FLASH cross-lab seat and never moves onto the Claude tiers.
  'prose.review': { wire: 'iu-openai', ...DEEPSEEK_FLASH.call },
  // Prose writer, for callers with no Claude Code session (Hermes, `narrative`). Gateway: `prose_write` was Opus
  // on the native Messages wire. Owner decision 2026-11-01: the HARD tier (Sonnet) on the native Messages
  // wire, paid from the credit; a drained credit (402) falls back to Terra medium on IU's chat wire (it was Terra medium on
  // the chat wire, with a DeepSeek fallback, from 2026-10-30). Claude Code sessions rewrite in the session on Max and
  // never call this route.
  'prose.write': { wire: 'anthropic', ...HARD.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
