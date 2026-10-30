import type { RouteEntry } from '../schema.ts'
import { LUNA_CALL_FALLBACK, EASY, OPENAI_AGENT_FALLBACK, STRONG } from './_shared.ts'

const routes = {
  // Review seats on the GPT stack (owner direction 2026-10-30). Nothing routes via Requesty (owner direction 2026-10-29),
  // no region is pinned. The router picks angles and a depth as a small JSON object: an easy call (Terra low, chat wire
  // with `response_format: json_object`). The first Haiku seat there agreed with the review verdict on 0.17 of the paired
  // eval's cases against Terra's 0.67, so the angles and the adversary are Terra medium; Terra low is too thin for them.
  'review.router': { wire: 'iu-openai', ...EASY, fallback: LUNA_CALL_FALLBACK },
  // The adversary is the cross-family critic (the writer is the calling Claude session) and the capability needs the
  // OpenAI chat wire. Terra medium; on a provider-balance failure the critique comes from Luna on another backend rather than not at all.
  'review.adversary': {
    wire: 'iu-openai',
    ...STRONG,
    maxOutputTokens: 16_000,
    fallback: LUNA_CALL_FALLBACK,
  },
  // Gateway: review_ocr (transport external-iu). `ocr` is an external CLI that talks to IU itself; the platform only
  // takes the model from here, and the wire says which of the CLI's protocols to speak (openai: chat completions). It
  // spends 1.5-3M tokens a run and reports tokens only, so the cost is unknown to the platform. Switched off by default
  // (AGW_REVIEW_OCR); no live `ocr` run on this model yet.
  'review.ocr': { wire: 'iu-openai', ...EASY, fallback: LUNA_CALL_FALLBACK },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry) and `review`
  // (synthesis), on the OpenCode harness. Reading code and finding what is wrong is the job of the review: Terra medium.
  'review.angle': { wire: 'opencode', ...STRONG, fallback: OPENAI_AGENT_FALLBACK },
  // Angles of a review the caller asked to run `depth: deep` (mother decision, 2026-10-29). Opt-in: a router-chosen deep
  // keeps `review.angle`; the review workflow names this route in the angle steps' `options.route`. Paired eval 2026-10-30
  // (12 recorded cases, `depth: deep`, same cases and scorer per arm): Terra medium and DeepSeek flash tie on every quality
  // metric (verdict agreement 0.67 both), Terra costs $0.43 a review against $0.51 and uses 13x fewer input tokens; Haiku
  // costs $0.04 but agreed with the verdict on 0.17. Recall is 0.05 or below on all three; Sonnet 5.5 (0.13, $0.54) is off
  // while the team key pays. Today the same seat as `review.angle`, kept as its own route so a deeper setting is one edit.
  'review.angle.deep': { wire: 'opencode', ...STRONG, fallback: OPENAI_AGENT_FALLBACK },
  'review.synthesis': { wire: 'opencode', ...STRONG, fallback: OPENAI_AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
