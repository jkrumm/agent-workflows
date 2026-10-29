import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, CALL_FALLBACK, HAIKU_55_EU_RATE, SONNET_55_EU_RATE } from './_shared.ts'

const routes = {
  // Review seats. Gateway: review_router is SINGLE_SHOT; adversary is deepseek-v4.1-flash on iu-openai.
  'review.router': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  'review.adversary': {
    wire: 'iu-openai',
    model: 'deepseek-v4.1-flash',
    maxOutputTokens: 16_000,
    fallback: CALL_FALLBACK,
  },
  // Gateway: review_ocr (transport external-iu). `ocr` is an external CLI that talks to IU itself; the platform only
  // takes the model from here, and the wire says which of the CLI's protocols to speak (openai: chat completions).
  'review.ocr': { wire: 'iu-openai', model: 'deepseek-v4.1-flash', fallback: CALL_FALLBACK },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry)
  // and `review` (synthesis, CLASSIFY tier), both Haiku 5.5 EU on the OpenCode harness.
  'review.angle': {
    wire: 'opencode',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },
  // Angles of a review the caller asked to run `depth: deep` (mother decision, 2026-10-29; Wave 6 experiment, 20 paired
  // cases: Haiku -> Sonnet angles recall 0.017 -> 0.13, precision 0.10 -> 0.50, cost per review $0.057 -> $0.542, about
  // 10x). Opt-in: a router-chosen deep keeps `review.angle`. The review workflow names this route in the angle steps'
  // `options.route`.
  'review.angle.deep': {
    wire: 'opencode',
    model: 'claude-sonnet-5-5-eu',
    rate: SONNET_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },
  'review.synthesis': {
    wire: 'opencode',
    model: 'claude-haiku-5-5-eu',
    rate: HAIKU_55_EU_RATE,
    fallback: AGENT_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
