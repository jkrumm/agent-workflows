import { claudeRate, costFromUsage } from '@agent-workflows/routes/pricing'
import type { TeeResult } from './tee.ts'

/** Text runs at about 2.9 characters a token (docs/spikes/gateway/passthrough.md), so bytes / 3 is the working figure. */
const BYTES_PER_TOKEN = 3
/** What a non-streamed call cut before its first byte may have generated. */
const CUT_OUTPUT_TOKENS = 8192

/** The request's side of an estimate. */
export interface RequestShape {
  bytes: number
  maxTokens: number | null
  streamed: boolean
}

export interface Charge {
  /** Priced from a complete reported usage block; the row's `cost_reported_usd`. */
  reportedUsd: number | null
  /** A credit pool's stand-in when there is none: `lane_detail.costEstimatedUsd` and the meter, never the row's cost. */
  estimateUsd: number | null
}

/** Tokens seen or, failing that, inferred from the bytes both ways. */
function estimatedTokens(tee: TeeResult, request: RequestShape): { input_tokens: number; output_tokens: number } {
  const seen = tee.tokens
  const seenInput = seen === null ? 0 : seen.input + seen.cacheRead + seen.cacheWrite5m + seen.cacheWrite1h
  const seenOutput = seen === null ? 0 : seen.output + seen.reasoning
  const input = seenInput > 0 ? seenInput : Math.ceil(request.bytes / BYTES_PER_TOKEN)
  if (tee.bytesReceived === 0 && !request.streamed) {
    return { input_tokens: input, output_tokens: Math.min(request.maxTokens ?? CUT_OUTPUT_TOKENS, CUT_OUTPUT_TOKENS) }
  }
  return { input_tokens: input, output_tokens: Math.max(seenOutput, Math.ceil(tee.bytesReceived / BYTES_PER_TOKEN)) }
}

/**
 * What a finished request costs. A complete usage block at the model's rate is real. On a credit pool anything less is
 * estimated, so the meter never trails what the org billed: an unknown model is the same usage at the top Claude rate;
 * a request that ended without a complete block (a cut, a fetch error, a 2xx nobody can read) is the tokens seen or
 * inferred, at the model's rate or else the top one. A non-2xx answer without usage cost nothing (`billable` false).
 */
export function chargeOf(input: {
  tee: TeeResult
  model: string | null
  claude: boolean
  creditPool: boolean
  billable: boolean
  request: RequestShape
}): Charge {
  const { tee, model, claude, creditPool, billable, request } = input
  const rate = model === null ? undefined : claudeRate(model)
  const top = claudeRate('opus')
  const reported = tee.complete && (claude || creditPool) ? costFromUsage('iu-anthropic', tee.usage, rate).usd : null
  if (reported !== null) return { reportedUsd: reported, estimateUsd: null }
  if (!creditPool || !billable) return { reportedUsd: null, estimateUsd: null }
  const atTop = tee.complete ? costFromUsage('iu-anthropic', tee.usage, top).usd : null
  if (atTop !== null) return { reportedUsd: null, estimateUsd: atTop }
  const tokens = estimatedTokens(tee, request)
  return { reportedUsd: null, estimateUsd: costFromUsage('iu-anthropic', tokens, rate ?? top).usd }
}
