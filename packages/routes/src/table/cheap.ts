import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, HAIKU_55_EU_RATE } from './_shared.ts'

const routes = {
  // Cheap single-shot seats. Gateway: SINGLE_SHOT (triage) over the iu-openai transport.
  // single-shot.ts sends max_completion_tokens >= 16000, because reasoning tokens count against it.
  'cheap.classify': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Gateway: CLASSIFY tier (overview, narrative), a Haiku 5.5 EU session on OpenCode. The platform
  // calls it as one native Messages request; the model is unchanged. The model exposes no effort.
  'cheap.summarize': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: CALL_FALLBACK,
  },
  'cheap.title': {
    wire: 'iu-anthropic',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
