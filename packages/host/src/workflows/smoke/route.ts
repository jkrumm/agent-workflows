import type { GatewayTransports, Usage } from '@agent-workflows/capabilities'
import {
  costFromUsage,
  type PatchInput,
  type ResolvedRoute,
  resolveRoute,
  type RouteId,
  routeIds,
} from '@agent-workflows/routes'
import { defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'

/** The agent the agent routes are probed with: no tools, no instructions beyond answering (`agents/smoke`). */
export const SMOKE_AGENT = 'smoke'
/** Fixed, eight words: a caller of `smoke.route` chooses the route and nothing else, so it can spend a few tokens. */
export const COMPLETE_PROMPT = 'Say hello back to this short smoke probe.'
export const AGENT_PROMPT = 'Reply with the single word ok.'
/** A single call needs no more; a route with an effort gets room to think before it answers (as `complete` does). */
const MAX_OUTPUT = 1_024
const MAX_OUTPUT_WITH_EFFORT = 32_000

/** Wires `make verify` or a capability covers: they bill per image, second or character, not per text token. */
const MEDIA_WIRES: readonly string[] = ['iu-gemini', 'iu-replicate', 'iu-decision']

/** The route with `patch` (the run's arm's `routes`) applied; the table at input validation and in a run without one. */
const resolved = (id: string, patch?: PatchInput): ResolvedRoute | null => {
  try {
    return (routeIds() as string[]).includes(id) ? resolveRoute(id as RouteId, patch) : null
  } catch {
    return null
  }
}

/** Why a route is not a text probe, or null when it is. */
export function refusal(route: ResolvedRoute): string | null {
  if (!MEDIA_WIRES.includes(route.wire) && route.price === undefined) return null
  return `${route.id} is a media route (wire ${route.wire}): make verify or its capability covers it, not smoke.route`
}

const input = z.object({
  route: z
    .string()
    .describe('A route id from `agw routes`; a text route on the anthropic, iu-openai or opencode wire')
    .superRefine((id, ctx) => {
      const route = resolved(id)
      if (!route) return ctx.addIssue({ code: 'custom', message: `unknown route "${id}" (see agw routes)` })
      const refused = refusal(route)
      if (refused) ctx.addIssue({ code: 'custom', message: refused })
    }),
})

const output = z.object({
  route: z.string(),
  model: z.string(),
  wire: z.string(),
  text: z.string().describe('The answer, as the model gave it'),
})

/** What one billed call cost, as `complete` reports it; the wire's own usage, priced by the route's rate. */
function usageOf(
  route: ResolvedRoute,
  attempt: Parameters<NonNullable<Parameters<GatewayTransports['openai']['complete']>[2]>>[0],
): Usage {
  const { cacheWrite1h, ...tokens } = attempt.tokens
  const cost = costFromUsage(
    route.wire,
    {
      cost: attempt.cost,
      prompt_tokens: tokens.input,
      completion_tokens: tokens.output,
      cache_read_input_tokens: tokens.cacheRead,
      cache_creation_input_tokens: tokens.cacheWrite ?? 0,
      ...(cacheWrite1h ? { cache_creation: { ephemeral_1h_input_tokens: cacheWrite1h } } : {}),
    },
    route.rate,
  )
  return { model: attempt.model, tokens, cost: cost.usd, costSource: cost.source }
}

export interface SmokeRouteDeps {
  transports: GatewayTransports
}

/**
 * `smoke.route`: one live call on one route, so a changed route is proved by the row it leaves
 * (`scripts/live-routes.sh`). A single-call route gets one completion on its own wire with no fallback and no retry (the probe is one billed call; a balance failure,
 * empty text or a stop that is not complete fails the run: the row must be the route's model); an agent route gets one agent step. The prompt is fixed.
 */
export function createSmokeRoute(deps: SmokeRouteDeps): HostWorkflow {
  const workflow = defineWorkflow({
    id: 'smoke.route',
    version: '2026-11-02.1',
    input,
    output,
    async run(ctx, { route: id }) {
      const route = resolved(id, ctx.arm?.routes)
      if (!route) throw new WorkflowError('invalid_input', `unknown route "${id}"`)
      const refused = refusal(route)
      if (refused) throw new WorkflowError('invalid_input', refused)
      if (route.wire === 'opencode') {
        const text = await ctx.agent('ask', {
          agent: SMOKE_AGENT,
          prompt: AGENT_PROMPT,
          output: z.string(),
          options: { output: 'text', route: id },
          retry: { attempts: 1 },
        })
        return { route: id, model: route.model, wire: route.wire, text }
      }
      const port = route.wire === 'iu-openai' ? deps.transports.openai : deps.transports.anthropic
      const { text, stop, stopDetail } = await ctx.step(
        'complete',
        async ({ addUsage, signal, attribution }) => {
          const effort = route.effort
          const result = await port.complete(
            {
              model: route.model,
              prompt: COMPLETE_PROMPT,
              effort,
              maxOutputTokens:
                route.maxOutputTokens ?? (effort && effort !== 'none' ? MAX_OUTPUT_WITH_EFFORT : MAX_OUTPUT),
              ...(attribution ? { attribution } : {}),
            },
            signal,
            (attempt) => addUsage(usageOf(route, attempt)),
          )
          return {
            text: result.text,
            stop: result.stop,
            ...(result.stopDetail ? { stopDetail: result.stopDetail } : {}),
          }
        },
        { retry: { attempts: 1 } },
      )
      if (stop !== 'complete') {
        throw new WorkflowError('invalid_output', `${id} did not finish its answer: stop "${stopDetail ?? stop}"`)
      }
      if (text.trim() === '') throw new WorkflowError('invalid_output', `${id} answered with empty text`)
      return { route: id, model: route.model, wire: route.wire, text }
    },
  })
  return {
    workflow,
    summary: 'One live call on one route with a fixed prompt; the proof behind make live-routes',
    cli: { positional: ['route'] },
  }
}
