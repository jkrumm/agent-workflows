import type { RouteEntry } from '../schema.ts'
import { ANTHROPIC_CALL_FALLBACK, EASY, OPENAI_CALL_FALLBACK, TRIVIAL } from './_shared.ts'

const routes = {
  // Single-call seats on the GPT stack. Nothing routes via Requesty (owner direction 2026-10-29); Luna and Terra answer
  // on IU's OpenAI chat wire. A label needs no judgment (Luna low); a summary or an extraction needs a clear read (Terra
  // low). `title` shares the label seat. IU reports no `usage.cost` for these, so the routes carry the rate.
  'cheap.classify': { wire: 'iu-openai', ...TRIVIAL, fallback: ANTHROPIC_CALL_FALLBACK },
  'cheap.summarize': { wire: 'iu-openai', ...EASY, fallback: OPENAI_CALL_FALLBACK },
  'cheap.extract': { wire: 'iu-openai', ...EASY, fallback: OPENAI_CALL_FALLBACK },
  'cheap.title': { wire: 'iu-openai', ...TRIVIAL, fallback: OPENAI_CALL_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
