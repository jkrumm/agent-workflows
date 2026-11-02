import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Gateway: SINGLE_SHOT. Owner direction (2026-10-29): triage never routes via Requesty, whose account answers 402/503
  // "Insufficient Balance". It picks a destination from a transcript: the EASY tier (Haiku high) on the native Messages
  // wire. It had no fallback while it ran on a GPT model (the only other candidate was a Requesty model); on Claude a
  // drained credit is a 402, so it falls back to Terra low on IU's chat wire (AWS mantle, not Requesty).
  triage: { wire: 'anthropic', ...EASY.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
