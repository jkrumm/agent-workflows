import type { RouteEntry } from '../schema.ts'
import { HAIKU_55_EU_RATE } from './_shared.ts'

const routes = {
  // Gateway: SINGLE_SHOT (deepseek-v4.1-flash on the IU chat wire), which IU forwards to Requesty-Global. Owner direction
  // (2026-10-29): triage never routes via Requesty, whose account answers 402/503 "Insufficient Balance". It runs on
  // the cheap Claude seat instead: IU's native Messages route to Haiku 5.5 EU, the route `cheap.summarize` already
  // serves. No fallback: the table's only one (`CALL_FALLBACK`, GPT-6.1 Terra) is a Requesty list model, and a
  // balance failure here is not worth a second, equally Requesty-backed attempt.
  triage: { wire: 'iu-anthropic', model: 'claude-haiku-5-5-eu', rate: HAIKU_55_EU_RATE },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
