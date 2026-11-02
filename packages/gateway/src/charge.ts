import { claudeRate, costFromUsage, type ProviderUsage } from '@agent-workflows/routes/pricing'
import { isRecord } from './json.ts'
import type { ReportedUsage, TeeResult } from './tee.ts'

/** Text runs at about 2.9 characters a token (docs/spikes/gateway/passthrough.md), so bytes / 3 is the working figure. */
const BYTES_PER_TOKEN = 3
/** What a non-streamed call cut before its first byte may have generated. */
const CUT_OUTPUT_TOKENS = 8192

/**
 * USD per use of a server tool, by its `usage.server_tool_use` count. Anthropic's pricing page,
 * https://docs.anthropic.com/en/docs/about-claude/pricing, read 2026-11-02 via `agw web read`: web search is $10 per
 * 1,000 searches. Web fetch has no charge beyond tokens. Code execution is billed by container time (free with web search
 * or fetch, else 1,550 free hours a month), so it has no per-use price. A count not listed here adds nothing.
 */
const SERVER_TOOL_USD: Readonly<Record<string, number>> = Object.freeze({ web_search_requests: 0.01 })

function serverToolUsd(usage: ReportedUsage | null): number {
  const tools = usage?.server_tool_use
  if (!isRecord(tools)) return 0
  let usd = 0
  for (const [name, uses] of Object.entries(tools)) {
    const price = Object.hasOwn(SERVER_TOOL_USD, name) ? SERVER_TOOL_USD[name] : undefined
    if (price !== undefined && typeof uses === 'number' && Number.isFinite(uses) && uses > 0) usd += price * uses
  }
  return usd
}

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

/**
 * The usage to price when none is complete. What the stream reported keeps its category, a cache read or a 1 h write at
 * its own rate; only what it never said is inferred from the bytes, as plain input or output.
 */
function estimatedUsage(tee: TeeResult, request: RequestShape): ProviderUsage {
  const seen = tee.tokens
  const seenPrompt = seen === null ? 0 : seen.input + seen.cacheRead + seen.cacheWrite5m + seen.cacheWrite1h
  const seenOutput = seen === null ? 0 : seen.output + seen.reasoning
  const prompt: ProviderUsage =
    seen !== null && seenPrompt > 0
      ? {
          input_tokens: seen.input,
          cache_read_input_tokens: seen.cacheRead,
          cache_creation_input_tokens: seen.cacheWrite5m + seen.cacheWrite1h,
          cache_creation: { ephemeral_1h_input_tokens: seen.cacheWrite1h },
        }
      : { input_tokens: Math.ceil(request.bytes / BYTES_PER_TOKEN) }
  const cutBeforeAnyByte = tee.bytesReceived === 0 && !request.streamed
  const output = cutBeforeAnyByte
    ? Math.min(request.maxTokens ?? CUT_OUTPUT_TOKENS, CUT_OUTPUT_TOKENS)
    : Math.max(seenOutput, Math.ceil(tee.bytesReceived / BYTES_PER_TOKEN))
  return { ...prompt, output_tokens: output }
}

/**
 * What a finished request costs. A complete usage block at the model's rate is real. On a credit pool anything less is
 * estimated, so the meter never trails what the org billed: an unknown model is the same usage at the top Claude rate;
 * a request that ended without a complete block (a cut, a fetch error, a 2xx nobody can read) is the tokens seen or
 * inferred, at the model's rate or else the top one. A non-2xx answer without usage cost nothing (`billable` false).
 * Server tools are billed per use beside the tokens, so a credit pool's figure carries them either way.
 */
export function chargeOf(input: {
  tee: TeeResult
  model: string | null
  creditPool: boolean
  billable: boolean
  request: RequestShape
}): Charge {
  const { tee, model, creditPool, billable, request } = input
  const rate = model === null ? undefined : claudeRate(model)
  const tools = creditPool ? serverToolUsd(tee.usage) : 0
  const withTools = (usd: number | null): number | null => (usd === null ? null : usd + tools)
  const top = claudeRate('opus')
  // The provider's own `usage.cost` wins on any wire (IU states it); without one or a Claude rate there is no figure.
  const reported = tee.complete ? costFromUsage('anthropic', tee.usage, rate).usd : null
  if (reported !== null) return { reportedUsd: withTools(reported), estimateUsd: null }
  if (!creditPool || !billable) return { reportedUsd: null, estimateUsd: null }
  const atTop = tee.complete ? costFromUsage('anthropic', tee.usage, top).usd : null
  if (atTop !== null) return { reportedUsd: null, estimateUsd: withTools(atTop) }
  const usage = estimatedUsage(tee, request)
  return { reportedUsd: null, estimateUsd: withTools(costFromUsage('anthropic', usage, rate ?? top).usd) }
}
