import type { RouteEntry } from '../schema.ts'
import { QUICK } from './_shared.ts'

const routes = {
  // Gateway: SINGLE_SHOT. Owner direction (2026-10-29): triage never routes via Requesty, whose account answers 402/503
  // "Insufficient Balance". It picks a destination from a transcript: Haiku on the native Messages wire. It had no fallback while it ran on a GPT model (the only other candidate was a Requesty model); on Claude a
  // drained credit is a 402, so it falls back to Terra low on IU's chat wire (AWS mantle, not Requesty).
  // Effort low (QUICK), not high: iris waits on this call for a transcribe-only memo, and at low its notification held on
  // every score of the suite (60 runs per arm) at 2.0 s p50 instead of 3.4 s; none was no faster and lost answers and
  // language: docs/evals/2026-11-20-iris-effort-arms.md. A reply that fails the schema is re-asked once, on this route.
  triage: { wire: 'anthropic', ...QUICK.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
