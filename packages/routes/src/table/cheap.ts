import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, HAIKU_55_RATE } from './_shared.ts'

const routes = {
  // Cheap single-shot seats. Gateway: SINGLE_SHOT (triage) on deepseek-v4.1-flash over the iu-openai transport, which IU
  // forwards to Requesty-Global (header x-middleware-forwarded-server, probed 2026-10-29). Owner direction: nothing routes
  // via Requesty, so a label and a reason come from Haiku 5.5, the model `triage` and `cheap.summarize` already run, on the same
  // chat wire with JSON mode (header "LiteLLM 2026 Gateway GDPR", probed 2026-10-29). IU reports no `usage.cost` there, so
  // the route carries the rate. No reasoning, so no 16k output floor.
  'cheap.classify': {
    wire: 'iu-openai',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: CALL_FALLBACK,
  },
  // Gateway: CLASSIFY tier (overview, narrative), a Haiku 5.5 session on OpenCode. The platform
  // calls it as one native Messages request; the model is unchanged. The model exposes no effort.
  'cheap.summarize': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: CALL_FALLBACK,
  },
  'cheap.title': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
