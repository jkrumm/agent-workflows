import type { RouteEntry } from '../schema.ts'
import { FAST } from './_shared.ts'

const routes = {
  // Gateway: SINGLE_SHOT (deepseek-v4.1-flash on the IU chat wire), which IU forwards to Requesty-Global. Owner direction
  // (2026-10-29): triage never routes via Requesty, whose account answers 402/503 "Insufficient Balance". It runs on
  // the cheap Claude seat instead: IU's native Messages route to Haiku 5.5, the route `cheap.summarize` already
  // serves. No fallback (parity with Wave 7's port); GPT-6.1 Terra answers from AWS mantle, not Requesty (header probed
  // 2026-10-29), so `CALL_FALLBACK` could be added.
  triage: { wire: 'iu-anthropic', ...FAST },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
