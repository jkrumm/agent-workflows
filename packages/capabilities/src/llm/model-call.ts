import {
  costFromUsage,
  type ResolvedRoute,
  type RouteId,
  RouteOverrideError,
  resolveRoute,
  UnknownRouteError,
} from '@agent-workflows/routes'
import type { z } from 'zod'
import type { Ctx, Usage } from '../context.ts'
import { CapabilityError, fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'
import type { AttemptUsage, ChatResult, IuTransports } from '../transports/port.ts'

/** What the model-backed capabilities are built from. Handlers close over it; `ctx` stays `{ signal, addUsage }`. */
export interface LlmDeps {
  transports: IuTransports
  /** Where `AGW_ROUTES` is read from. Default `process.env`. */
  env?: Env
}

/** Reasoning tokens count against the ceiling, so a route with effort and no ceiling gets room to think. */
const DEFAULT_MAX_OUTPUT = 8_192
const DEFAULT_MAX_OUTPUT_WITH_EFFORT = 32_000
/** How much of a rejected answer is echoed back on the re-ask: enough to repair, bounded. */
const RETRY_ECHO_CHARS = 4_000
const MAX_ATTEMPTS = 2

export function resolve(deps: LlmDeps, routeId: RouteId): ResolvedRoute {
  try {
    return resolveRoute(routeId, deps.env ?? process.env)
  } catch (error) {
    if (error instanceof UnknownRouteError || error instanceof RouteOverrideError) {
      throw new CapabilityError('NOT_CONFIGURED', error.message, undefined, { cause: error })
    }
    throw error
  }
}

/** A reported attempt as a `Usage`; `undefined` stands for a call the provider returned no usage for. */
export function toUsage(route: ResolvedRoute, model: string, attempt: AttemptUsage | undefined): Usage {
  const tokens = attempt?.tokens ?? { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
  const cost = costFromUsage(
    route.wire,
    attempt
      ? {
          cost: attempt.cost,
          // `tokens.input` counts cache reads and writes, as `prompt_tokens` does.
          prompt_tokens: tokens.input,
          completion_tokens: tokens.output,
          cache_read_input_tokens: tokens.cacheRead,
          cache_creation_input_tokens: tokens.cacheWrite ?? 0,
        }
      : null,
    route.rate,
  )
  return { model: attempt?.model ?? model, tokens, cost: cost.usd, costSource: cost.source }
}

/** The error for an unusable answer, or null when `result.text` can be used. */
function contentFailure(route: ResolvedRoute, result: ChatResult): CapabilityError | null {
  if (result.stop === 'length') {
    const reason = result.text ? 'truncated' : 'starved'
    const why =
      reason === 'starved'
        ? 'reasoning used the whole output allowance and no answer came back'
        : 'the answer stops mid-way'
    return fail('OUTPUT_TRUNCATED', `${route.id}: output hit the ceiling, ${why}`, { reason })
  }
  if (!result.text) {
    return fail(
      'UPSTREAM_ERROR',
      `${route.id}: the model returned no text (stop: ${result.stopDetail ?? result.stop})`,
      {},
    )
  }
  if (result.stop === 'other') {
    return fail(
      'UPSTREAM_ERROR',
      `${route.id}: the model stopped with "${result.stopDetail}", the answer is not complete`,
      {},
    )
  }
  return null
}

export interface CompleteArgs {
  routeId: RouteId
  system?: string
  prompt: string
  json?: boolean
  ctx: Ctx
}

/** One completion through the route's wire. Every billed call is reported to `ctx.addUsage`, failures included. */
export async function complete(deps: LlmDeps, args: CompleteArgs): Promise<{ text: string; route: ResolvedRoute }> {
  const route = resolve(deps, args.routeId)
  const port =
    route.wire === 'iu-openai'
      ? deps.transports.openai
      : route.wire === 'iu-anthropic'
        ? deps.transports.anthropic
        : undefined
  if (!port) {
    throw fail('NOT_CONFIGURED', `${route.id}: wire "${route.wire}" is not a single-call text wire`)
  }
  // The adapter reports every attempt that came back with usage, failed ones included. A call that
  // returned none is still a call: report it with unknown tokens and cost.
  let reported = 0
  const result = await port.complete(
    {
      model: route.model,
      system: args.system,
      prompt: args.prompt,
      json: args.json,
      effort: route.effort,
      maxOutputTokens:
        route.maxOutputTokens ??
        (route.effort && route.effort !== 'none' ? DEFAULT_MAX_OUTPUT_WITH_EFFORT : DEFAULT_MAX_OUTPUT),
    },
    args.ctx.signal,
    (attempt) => {
      reported++
      args.ctx.addUsage(toUsage(route, route.model, attempt))
    },
  )
  if (reported === 0) args.ctx.addUsage(toUsage(route, result.model, undefined))
  const failure = contentFailure(route, result)
  if (failure) throw failure
  return { text: result.text, route }
}

/** Best-effort JSON from a model answer: strips a code fence, slices first `{` to last `}`. `null` on failure. */
export function parseJsonLoose(raw: string): unknown {
  let s = raw.trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence?.[1] !== undefined) s = fence[1].trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) s = s.slice(first, last + 1)
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function retryPrompt(prompt: string, rejected: string, reason: string): string {
  return (
    `${prompt}\n\n---\nRETRY: your previous response was rejected: ${reason}\n\n` +
    `Previous response (truncated):\n${rejected.slice(0, RETRY_ECHO_CHARS)}\n\n` +
    'Return ONLY the corrected JSON object. Your entire message must be a single JSON object, no text before or after it.'
  )
}

/**
 * A completion that must come back as JSON matching `schema`: a tolerant parse, then one re-ask with
 * the rejection reason, then `INVALID_OUTPUT`. A transport failure is not re-asked (the adapter
 * already retried it, and a second pass would only bill twice).
 */
export async function completeJson<S extends z.ZodType>(
  deps: LlmDeps,
  args: Omit<CompleteArgs, 'json'> & { schema: S },
): Promise<{ data: z.output<S>; route: ResolvedRoute; attempts: number }> {
  let prompt = args.prompt
  let reason = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { text, route } = await complete(deps, { ...args, prompt, json: true })
    const parsed = parseJsonLoose(text)
    if (parsed === null) {
      reason = 'the response was not a valid JSON object'
    } else {
      const checked = args.schema.safeParse(parsed)
      if (checked.success) return { data: checked.data, route, attempts: attempt }
      reason = `the JSON did not match the schema: ${checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    }
    if (attempt < MAX_ATTEMPTS) prompt = retryPrompt(args.prompt, text, reason)
  }
  throw fail('INVALID_OUTPUT', `${args.routeId}: model output rejected after ${MAX_ATTEMPTS} attempts, ${reason}`, {
    attempts: MAX_ATTEMPTS,
    reason,
  })
}
