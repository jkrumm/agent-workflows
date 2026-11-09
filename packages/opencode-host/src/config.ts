import { fileURLToPath } from 'node:url'
import {
  CLAUDE_MODELS,
  claudeRate,
  CONTEXT_LIMITS,
  EFFORTS,
  fallbackRoute,
  type PatchInput,
  type Rate,
  type ResolvedRoute,
  type RouteId,
  resolveRoute,
  routeIds,
  takesEffort,
} from '@agent-workflows/routes'
import type { ModelRef } from './client.ts'
import { basePolicy } from './locations.ts'

type Env = Record<string, string | undefined>

/**
 * OpenCode provider ids the server config defines. Every leg goes through the inference gateway with the door token of
 * the caller `agw-opencode`: it opens the gateway only, and the server holds no provider key.
 */
export const PROVIDER_ANTHROPIC = 'anthropic'
export const PROVIDER_CHAT = 'iu-chat'
/** The gateway's OpenAI path over the Responses API: OpenAI's own models call tools only there (IU, 2026-10-28). */
export const PROVIDER_RESPONSES = 'iu-responses'

/** The plugin that sets the gateway's attribution headers, in this package. `installPlugin` is what a server loads. */
export const ATTRIBUTION_PLUGIN = fileURLToPath(new URL('../plugin/agw-attribution', import.meta.url))

const GATEWAY_KEY = '{env:AGW_GATEWAY_TOOL_TOKEN}'

/** The gateway's origin and the door token from `AGW_GATEWAY_URL` and `AGW_GATEWAY_TOOL_TOKEN`. Messages name the variable, never a value. */
export function gatewayFromEnv(env: Env = process.env): { url: string; token: string } {
  const raw = env.AGW_GATEWAY_URL?.trim()
  if (!raw) throw new Error('AGW_GATEWAY_URL is not set')
  const token = env.AGW_GATEWAY_TOOL_TOKEN?.trim()
  if (!token) throw new Error('AGW_GATEWAY_TOOL_TOKEN is not set')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('AGW_GATEWAY_URL is not a URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.username ||
    url.password
  ) {
    throw new Error('AGW_GATEWAY_URL must be an http(s) origin, without a path')
  }
  return { url: url.origin, token }
}

/**
 * The `opencode`-wire routes of the table, each followed by its fallback when it has one: the models the server config
 * serves besides the Claude models, which it serves all of (`opencodeModels` in `@agent-workflows/routes` is the whole
 * set, which an arm's patch is checked against).
 */
export function opencodeRoutes(): ResolvedRoute[] {
  return routeIds()
    .map((id) => resolveRoute(id))
    .filter((route) => route.wire === 'opencode')
    .flatMap((route) => {
      const fallback = fallbackRoute(route)
      return fallback ? [route, fallback] : [route]
    })
}

/**
 * Which leg serves a model, by its family alone: no other route sharing the id can move it. OpenAI's own models
 * (`gpt-`) go the Responses way (an agent session needs tool calls, which they make only there), a `claude-` model the
 * gateway's Anthropic path, anything else the OpenAI-compatible chat way. A single-call route on the same model (Haiku on
 * `iu-openai`, say) does not change the leg an agent session uses.
 */
function providerFor(model: string): string {
  if (model.startsWith('gpt-')) return PROVIDER_RESPONSES
  return model.startsWith('claude-') ? PROVIDER_ANTHROPIC : PROVIDER_CHAT
}

/** The rate OpenCode prices a route's messages with (its config cost rows): the route's own, nothing borrowed. */
export function rateFor(route: ResolvedRoute): Rate | null {
  return route.rate ?? null
}

/**
 * The session's model for a route: provider, model and effort (as a variant) from the route table with `patch` (the
 * run's arm's `routes`) applied. The server serves every effort variant of every model a patch may name.
 */
export function modelRef(routeId: RouteId, patch?: PatchInput): { route: ResolvedRoute; model: ModelRef } {
  const route = resolveRoute(routeId, patch)
  if (route.wire !== 'opencode') throw new Error(`route "${routeId}" is on the ${route.wire} wire, not opencode`)
  return { route, model: refFor(route) }
}

/** The session's model for a route's provider-balance fallback, or `undefined` when the route has none. */
export function fallbackModelRef(
  routeId: RouteId,
  patch?: PatchInput,
): { route: ResolvedRoute; model: ModelRef } | undefined {
  const route = fallbackRoute(modelRef(routeId, patch).route)
  return route ? { route, model: refFor(route) } : undefined
}

function refFor(route: ResolvedRoute): ModelRef {
  const id = route.contextLimit === undefined ? route.model : contextAlias(route.model, route.contextLimit)
  const model: ModelRef = { providerID: providerFor(route.model), id }
  if (route.effort) model.variant = route.effort
  return model
}

/**
 * Why a bounded route gets its own model row (`contextLimit`), and how the row's window is chosen. Read from OpenCode
 * 2.0.32 (sst/opencode, tag v2.0.32, `packages/core/src/session/compaction.ts`, `model-request.ts`, `runner/llm.ts`;
 * README §Bounded context has the links and what was measured):
 *
 * - Before every model call of a step the runner asks for an `auto` compaction. It runs when `estimate >= ceiling`,
 *   with `ceiling = window - buffer` (`calculateCeiling`; `buffer` is the top-level `compaction.buffer`, set here to
 *   `COMPACTION_BUFFER`; unset it is `max(floor(window / 10), 16_000)`; `window` is the model row's `limit.context`).
 * - `estimate` is the last response's measured `input + cache.read + cache.write + output + reasoning`, plus a
 *   chars/4 estimate of what came after it (the tool results). With no response yet (the first call) all of the request
 *   is estimated by chars/4. A request goes out only when its estimate is under the ceiling.
 * - The summary call is the history (as is when its chars/4 estimate is within the ceiling less the summary prompt,
 *   else flattened to that size with tool output cut to 1,250 characters) plus the summary prompt. Its `max_tokens` is
 *   `min(limit.output, 32_000, window - request)`, so the `buffer` is the room a summary has, and 32k is all it can
 *   have. The route's thinking (`effort`) is sent on the summary call too and shares that `max_tokens`.
 * - A window also clamps the `max_tokens` of every call to `window - prompt`, which the buffer keeps at `buffer`+.
 *
 * So no prompt can pass `ceiling * (1 + e)`, where `e` is how far chars/4 undercounts the real tokens (the first
 * call and the summary call are estimated whole; a call after tool results is off only by the results' share, which is
 * smaller). A bound `B` therefore takes `ceiling = B / (1 + e)`. `e` is ASSUMED at 25% (OpenCode itself assumes 15%
 * for its output sizing; code and JSON tokenize denser than 4 chars), not measured: the headroom is `B - ceiling` =
 * 12k, 16k and 20k for 60k, 80k and 100k. A first prompt over the ceiling is summarised before it runs (lossy), so a
 * route's bound has to sit well above its first prompt. `windowFor` is the `limit.context` that gives that ceiling.
 */
const ESTIMATE_UNDERCOUNT = 0.25

/**
 * `compaction.buffer`: the room a compaction summary has. The summary call asks for at most 32,000 output tokens
 * (OpenCode's `SUMMARY_OUTPUT_MAX`) and gets `window - request`, which was 10,733 with the default 16k reserve
 * (measured on 2.0.32 for a 100k bound), thinking included. 40k is those 32k and the summary prompt's own size and slack.
 */
export const COMPACTION_BUFFER = 40_000

/** The `limit.context` whose compaction ceiling is `limit / (1 + ESTIMATE_UNDERCOUNT)`: 88k, 104k and 120k. */
export function windowFor(limit: number): number {
  return Math.floor(limit / (1 + ESTIMATE_UNDERCOUNT)) + COMPACTION_BUFFER
}

/**
 * The key of a model's bounded row: the same model under a name that carries the bound. The row sends the real model
 * to the provider (`modelID`), so the gateway, usage and pricing only ever see `model`.
 */
export function contextAlias(model: string, limit: number): string {
  return `${model}~ctx${limit}`
}

/** What a model row is built from: a route's, or a bare Claude model with its table rate. */
type RowSource = Pick<ResolvedRoute, 'model' | 'maxOutputTokens'> & { rate?: Rate | null }

/**
 * One row per model for routes that may share it: OpenCode prices and limits a model, not a route, so the row must not
 * depend on which route comes first. The output limit is the strictest of the routes that set one (a route without
 * one takes it too: the model is capped for all), and the rate must be the same on every route, else the build fails
 * naming the model and the routes (a rate cannot be both).
 */
function sharedRows(routes: readonly ResolvedRoute[]): Map<string, ReturnType<typeof modelRow>> {
  const byModel = new Map<string, ResolvedRoute[]>()
  for (const route of routes) byModel.set(route.model, [...(byModel.get(route.model) ?? []), route])
  const rows = new Map<string, ReturnType<typeof modelRow>>()
  for (const [model, sharing] of byModel) {
    const first = sharing[0] as ResolvedRoute
    const conflicting = sharing.filter((r) => JSON.stringify(r.rate ?? null) !== JSON.stringify(first.rate ?? null))
    if (conflicting.length > 0) {
      const ids = [first, ...conflicting].map((r) => `${r.id}${r.isFallback ? ' (fallback)' : ''}`).join(', ')
      throw new Error(`model "${model}" has different rates on routes ${ids}; OpenCode prices a model, not a route`)
    }
    const limits = sharing.flatMap((r) => (r.maxOutputTokens ? [r.maxOutputTokens] : []))
    const maxOutputTokens = limits.length > 0 ? Math.min(...limits) : undefined
    rows.set(model, modelRow({ model, rate: first.rate, maxOutputTokens }, providerFor(model)))
  }
  return rows
}

function modelRow(route: RowSource, provider: string) {
  const rate = route.rate ?? null
  return {
    name: route.model,
    // The gateway may serve this from IU, which answered the `thinking-binding-controls` beta with a 503 for EU Haiku
    // ids (agent-gateway, measured 2026-10-14); without the binding, `thinking` is omitted (the model default).
    ...(provider === PROVIDER_ANTHROPIC ? { compatibility: { supportsThinkingBlockBinding: false } } : {}),
    ...(route.maxOutputTokens ? { limit: { output: route.maxOutputTokens } } : {}),
    ...(rate
      ? {
          cost: {
            input: rate.inputPerM,
            output: rate.outputPerM,
            ...(rate.cacheReadPerM === undefined
              ? {}
              : {
                  cache: {
                    read: rate.cacheReadPerM,
                    ...(rate.cacheWritePerM === undefined ? {} : { write: rate.cacheWritePerM }),
                  },
                }),
          },
        }
      : {}),
    variants: EFFORTS.filter((effort) => takesEffort(route.model, effort)).map((effort) => ({
      id: effort,
      settings: variantSettings(effort, provider),
    })),
  }
}

/**
 * Per-effort provider options. OpenCode's Anthropic protocol ignores `reasoningEffort`: it reads `effort`
 * (`output_config.effort`) and `thinking`. Effort `none` turns thinking off; any other effort runs adaptive thinking.
 */
function variantSettings(effort: string, provider: string): Record<string, unknown> {
  if (provider !== PROVIDER_ANTHROPIC) return { reasoningEffort: effort }
  if (effort === 'none') return { thinking: { type: 'disabled' } }
  return { effort, thinking: { type: 'adaptive' } }
}

/**
 * `OPENCODE_CONFIG_CONTENT`: the three providers with every `opencode`-wire route's model and its fallback's, and every
 * Claude model (`CLAUDE_MODELS`, priced with `claudeRate`, Opus included though no route runs it), each with every
 * effort variant it can run (`EFFORTS`; a Sonnet has no `none`), so a run whose arm moves an agent route to another of
 * these models or effort opens its session on the running server, without a restart. A model is one row whatever
 * routes share it (`sharedRows`): the strictest output limit of them, and one rate (routes naming different rates for
 * a model fail the build). `options.routes` replaces the table's routes (tests). The
 * attribution plugin (`options.plugin`, an absolute directory), no updates, no share. The only credential is the door
 * token, by reference to the server's env.
 * Each Claude model also has one bounded row per `CONTEXT_LIMITS` value, `<model>~ctx<limit>` (`contextAlias`), for a
 * route with a `contextLimit`.
 * The Anthropic leg sends `x-agw-fallback: none`: with no credit pool left the gateway answers a 402 and the route's own
 * fallback takes over, rather than paying for Claude on IU.
 * The server policy is deny by default as the sessions' are (`basePolicy`: catch-all deny, then the read-only tools), so
 * a session created without rules, or by something other than the host, is not allow-all. A session's own rules come
 * after it and win (measured on 2.0.32, `test/live-permissions.test.ts`). Unattended sessions must never block on a
 * question: `question` is denied and so is `external_directory` (its base policy is `ask`). An agent's own rules go in
 * its location's `opencode.json` (`AgentDefinition.config`).
 */
export function buildServerConfig(
  options: { plugin?: string; routes?: readonly ResolvedRoute[] } = {},
): Record<string, unknown> {
  const models: Record<string, Record<string, unknown>> = {
    [PROVIDER_ANTHROPIC]: {},
    [PROVIDER_CHAT]: {},
    [PROVIDER_RESPONSES]: {},
  }
  for (const [model, row] of sharedRows(options.routes ?? opencodeRoutes())) {
    const rows = models[providerFor(model)] as Record<string, unknown>
    rows[model] = row
  }
  for (const model of CLAUDE_MODELS) {
    const rows = models[PROVIDER_ANTHROPIC] as Record<string, unknown>
    rows[model] ??= modelRow({ model, rate: claudeRate(model) }, PROVIDER_ANTHROPIC)
  }
  // A bounded copy of every Claude row for each allowed bound (`contextLimit`, one of `CONTEXT_LIMITS`: an arm may pick
  // any without a restart): same cost, variants and compatibility, a window that makes the session compact in time, and
  // `modelID` so the provider is still called with the real model.
  // (OpenCode 2.0.32 reads `modelID` in its config; a key named `id` is dropped silently, not an alias.)
  const claude = models[PROVIDER_ANTHROPIC] as Record<string, Record<string, unknown>>
  for (const model of CLAUDE_MODELS) {
    const base = claude[model] as Record<string, unknown>
    for (const limit of CONTEXT_LIMITS) {
      claude[contextAlias(model, limit)] = {
        ...structuredClone(base),
        modelID: model,
        limit: { ...(base.limit as object | undefined), context: windowFor(limit) },
      }
    }
  }
  return {
    update: 'disable',
    share: 'disabled',
    // The room a summary has (`COMPACTION_BUFFER`); automatic compaction stays on (its default), and `keep` too.
    compaction: { buffer: COMPACTION_BUFFER },
    plugins: [options.plugin ?? ATTRIBUTION_PLUGIN],
    permissions: [
      ...basePolicy(),
      { action: 'question', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ],
    providers: {
      [PROVIDER_ANTHROPIC]: {
        package: 'aisdk:@ai-sdk/anthropic',
        name: 'Anthropic through the gateway',
        settings: { baseURL: '{env:AGW_GATEWAY_URL}/anthropic/v1', apiKey: GATEWAY_KEY },
        headers: { 'x-agw-fallback': 'none' },
        models: models[PROVIDER_ANTHROPIC],
      },
      [PROVIDER_CHAT]: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'The gateway, OpenAI path (chat completions)',
        settings: { baseURL: '{env:AGW_GATEWAY_URL}/openai/v1', apiKey: GATEWAY_KEY },
        models: models[PROVIDER_CHAT],
      },
      [PROVIDER_RESPONSES]: {
        package: 'aisdk:@ai-sdk/openai',
        name: 'The gateway, OpenAI path (Responses)',
        settings: { baseURL: '{env:AGW_GATEWAY_URL}/openai/v1', apiKey: GATEWAY_KEY },
        models: models[PROVIDER_RESPONSES],
      },
    },
  }
}
