import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, CALL_FALLBACK, HAIKU_55_RATE, HAIKU_CALL_FALLBACK, TERRA, TERRA_RATE } from './_shared.ts'

const routes = {
  // Review seats. Gateway: review_router is SINGLE_SHOT and the adversary is deepseek-v4.1-flash, both on iu-openai. IU
  // forwards that id to Requesty-Global (response header x-middleware-forwarded-server, probed 2026-10-29), and no other
  // DeepSeek id on the endpoint avoids Requesty (`DeepSeek-V4-Flash` also answers from Requesty-Global; the one
  // Nebius-hosted `deepseek-ai/DeepSeek-V3.2` answers "model does not exist"). Owner direction: nothing routes via Requesty.
  // The router picks angles and a depth as a small JSON object, the job `triage` does on Haiku 5.5. Haiku answers on the
  // same OpenAI chat wire the seat already uses, with `response_format: json_object` and reasoning_effort accepted (200,
  // header "LiteLLM 2026 Gateway GDPR", probed 2026-10-29), at a tenth of Terra's price; IU reports no `usage.cost` for it
  // there, so the route carries the rate. Fallback: Terra (AWS mantle, probed).
  'review.router': {
    wire: 'iu-openai',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: CALL_FALLBACK,
  },
  // The adversary is the cross-family critic (the writer is the calling Claude session) and the capability needs the
  // OpenAI chat wire, so Haiku is out. Of the non-Requesty candidates, `gpt-6.1-terra` answers on the chat wire with
  // reasoning_effort (header: AWS mantle us-east-1, probed 2026-10-29) and has a published card; `Kimi-K2.6` answers
  // from IU's Sweden sink but IU reports no cost for it and no list price is on record. Terra reports no `usage.cost`
  // on this wire, so the route carries its rate. The fallback is Haiku 5.5 on the chat wire (Terra would fall back
  // to itself): on a provider-balance failure the critique comes from the writer's family rather than not at all.
  'review.adversary': {
    wire: 'iu-openai',
    model: TERRA.model,
    effort: TERRA.effort,
    maxOutputTokens: 16_000,
    rate: TERRA_RATE,
    fallback: HAIKU_CALL_FALLBACK,
  },
  // Gateway: review_ocr (transport external-iu). `ocr` is an external CLI that talks to IU itself; the platform only
  // takes the model from here, and the wire says which of the CLI's protocols to speak (openai: chat completions). Haiku 5.5
  // for the reasons of `review.router` (OCR spends 1.5-3M tokens a run; the cost is unknown to the platform either way,
  // `ocr` reports tokens only). Switched off by default (AGW_REVIEW_OCR); no live `ocr` run on this model yet.
  'review.ocr': { wire: 'iu-openai', model: 'claude-haiku-5-5', rate: HAIKU_55_RATE, fallback: CALL_FALLBACK },
  // Gateway: ANGLE_OC (review_angle_senior_dev|typescript|frontend|qa all resolve to the same entry)
  // and `review` (synthesis, CLASSIFY tier), both Haiku 5.5 on the OpenCode harness.
  'review.angle': {
    wire: 'opencode',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: AGENT_FALLBACK,
  },
  // Angles of a review the caller asked to run `depth: deep` (mother decision, 2026-10-29). Opt-in: a router-chosen deep keeps
  // `review.angle`; the review workflow names this route in the angle steps' `options.route`. Sonnet 5.5 here (Wave 6
  // experiment: recall 0.017 -> 0.13, $0.057 -> $0.542 a review) is off since 2026-10-30: owner direction, DeepSeek flash only
  // while the team key pays.
  'review.angle.deep': {
    wire: 'opencode',
    model: 'deepseek-v4.1-flash',
    rate: { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 },
    fallback: AGENT_FALLBACK,
  },
  'review.synthesis': {
    wire: 'opencode',
    model: 'claude-haiku-5-5',
    rate: HAIKU_55_RATE,
    fallback: AGENT_FALLBACK,
  },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
