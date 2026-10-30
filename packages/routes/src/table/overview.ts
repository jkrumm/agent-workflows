import type { RouteEntry } from '../schema.ts'
import { CALL_FALLBACK, FAST } from './_shared.ts'

const routes = {
  // Overview seat. Gateway: `overview`, CLASSIFY tier (Haiku 5.5, one batched prompt-only session). The platform calls it
  // as one native Messages request, like `cheap.summarize` and `triage`; the model is unchanged and exposes no effort.
  // Owner direction (2026-10-29): nothing routes via Requesty, no region is pinned.
  'overview.classify': {
    wire: 'iu-anthropic',
    ...FAST,
    fallback: CALL_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
