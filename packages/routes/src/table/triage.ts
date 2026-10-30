import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Gateway: SINGLE_SHOT. Owner direction (2026-10-29): triage never routes via Requesty, whose account answers 402/503
  // "Insufficient Balance". It picks a destination from a transcript: Terra low on IU's chat wire (AWS mantle, not
  // Requesty). No fallback, as before: the only candidate that is not OpenAI's own balance is a Requesty model.
  triage: { wire: 'iu-openai', ...EASY },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
