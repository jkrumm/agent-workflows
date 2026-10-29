import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, HAIKU_55_RATE } from './_shared.ts'

const routes = {
  // Overview seat. Gateway: `overview`, CLASSIFY tier (Haiku 5.5, one batched prompt-only session). The platform calls it
  // as one native Messages request, like `cheap.summarize` and `triage`; the model is unchanged and exposes no effort.
  // Owner direction (2026-10-29): nothing routes via Requesty, no region is pinned.
  'overview.classify': {
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
