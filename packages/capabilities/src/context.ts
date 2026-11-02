import type { PatchInput } from '@agent-workflows/routes'
import { z } from 'zod'

export const usageSchema = z.object({
  /** The canonical model id (`canonicalModel`), not the provider's echo. */
  model: z.string(),
  /** The route id the call was resolved from (a fallback call keeps the primary's); absent for a call with no route. */
  route: z.string().optional(),
  /** Raw provider counts: `input` includes cache reads and writes, `output` includes reasoning. `cacheWrite` is set by wires that report it. */
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative().optional(),
    reasoning: z.number().int().nonnegative(),
  }),
  /** USD; `null` when neither the provider nor the route's rate gives a price, never 0. */
  cost: z.number().nonnegative().nullable(),
  costSource: z.enum(['provider', 'rate', 'unknown']),
})
export type Usage = z.infer<typeof usageSchema>

/**
 * Who a model call is for: the run step that makes it. The transports send it to the gateway as `x-agw-*` headers
 * (`gatewayHeaders`), which land on the gateway's usage row and span. Structurally the same `attribution` the
 * runtime's step context carries.
 */
export interface Attribution {
  /** The run the step belongs to. */
  runId: string
  /** The root of its run tree: the gateway's session, so a run tree stays on one credit pool. */
  rootId: string
  workflow: string
  step: string
  purpose: string
  project?: string
  workspace?: string
  traceparent?: string
  /**
   * Who asked agw for the run tree: the root run's caller (`claude-code`, `hermes`, `cli`, or `eval` / `host` for a run
   * the host started itself). The gateway stores it as `lane_detail.origin`; attribution only, it never changes a pick.
   */
  origin?: string
  /**
   * Set on a call that runs because the route's primary was refused for balance: the refused response's
   * `x-agw-request-id` (`refusedRequestId`), or `unknown` where the caller cannot see it. The gateway stores it as
   * `lane_detail.routeFallback`. Per call, never run-scoped: only the fallback call carries it.
   */
  routeFallback?: string
}

/**
 * The calling run's experiment arm, as the runtime's step scope carries it: every route the capability resolves applies
 * `routes` (`resolve(id, ctx)`). Absent outside an armed run: the plain route table.
 */
export interface CallArm {
  routes?: PatchInput
}

/** What a handler sees. Structurally the same `addUsage`, `attribution` and `arm` the runtime's step context carries. */
export interface Ctx {
  signal: AbortSignal
  /** Report one billed model call. A re-ask after a rejected answer reports each attempt; the transport's own
   * retries of failed requests (429, 5xx, dropped connections) report nothing, because no usage came back. */
  addUsage: (usage: Usage) => void
  /** The calling step; absent outside a run (a test, a call with no step). */
  attribution?: Attribution
  /** The calling run's arm; absent outside an armed run. */
  arm?: CallArm
}
