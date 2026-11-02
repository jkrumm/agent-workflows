import type { RouteEntry } from '../schema.ts'
import { CRITIC, EASY, HARD } from './_shared.ts'

const routes = {
  // Review routes (owner decision 2026-11-01: onto Claude, provisional until Waves 9-10). Nothing routes via Requesty
  // (owner direction 2026-10-29), no region is pinned. The router picks angles and a depth as a small JSON object: an easy
  // call, the EASY tier (Haiku high) on the native Messages wire; a drained credit (402) moves it to Terra low on the chat
  // wire. History (2026-10-30): the first Haiku route there agreed with the review verdict on 0.17 of the paired eval's
  // cases against Terra's 0.67, which is why the angles and the adversary were Terra medium. The 2026-10-31 eval put
  // Haiku at effort high at the Haiku knee.
  'review.router': { wire: 'anthropic', ...EASY.call },
  // The adversary stays on GPT by design, the CRITIC cross-lab seat (Terra medium, not a tier): it is the cross-family
  // critic (the writer is the calling Claude session), and its capability refuses any wire but the OpenAI chat wire. A
  // Claude critic of a Claude writer defeats it. On a provider-balance failure the critique comes from Luna on another
  // backend rather than not at all.
  'review.adversary': { wire: 'iu-openai', ...CRITIC.call, maxOutputTokens: 16_000 },
  // Gateway: review_ocr (transport external-iu). `ocr` is an external CLI that talks to IU itself; the platform only
  // takes the model from here, and the wire says which of the CLI's protocols to speak (anthropic: Messages on the
  // gateway; anything else: chat completions; review/ocr.ts). It spends 1.5-3M tokens a run and reports tokens only, so
  // the cost is unknown to the platform. Switched off by default (AGW_REVIEW_OCR); no live `ocr` run on this model yet.
  'review.ocr': { wire: 'anthropic', ...EASY.call },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry) and `review`
  // (synthesis), on the OpenCode harness. The EASY tier (Haiku high), the concept v3.5 split restored (owner, 2026-11-02):
  // on Sonnet the angles were $46.29 of the $52.50 that 67 production reviews spent in two days ($0.78 a review, 14.8M
  // 5-minute cache-write tokens). Deep angles and the synthesis stay on Sonnet. The review's seats are decided by the
  // Wave 11 sweep; on a drained credit the step reopens on Terra low over Responses.
  'review.angle': { wire: 'opencode', ...EASY.agent },
  // Angles of a review the caller asked to run `depth: deep` (mother decision, 2026-10-29). Opt-in: a router-chosen deep
  // keeps `review.angle`; the review workflow names this route in the angle steps' `options.route`. History, paired eval
  // 2026-10-30 (12 recorded cases, `depth: deep`, same cases and scorer per arm): Terra medium and DeepSeek flash tie on
  // every quality metric (verdict agreement 0.67 both), Terra costs $0.43 a review against $0.51 and uses 13x fewer input
  // tokens; Haiku costs $0.04 but agreed with the verdict on 0.17. Recall is 0.05 or below on all three; Sonnet
  // (0.13, $0.54) was off while the team key paid and is the HARD tier now that the credit pays: the angles of a caller's
  // `depth: deep` run on Sonnet, the default angles on Haiku (`review.angle`).
  'review.angle.deep': { wire: 'opencode', ...HARD.agent },
  'review.synthesis': { wire: 'opencode', ...HARD.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
