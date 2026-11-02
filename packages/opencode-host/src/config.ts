import { fileURLToPath } from 'node:url'
import {
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
 * serves (`opencodeModels` in `@agent-workflows/routes` is the same set, which an arm's patch is checked against).
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
  const model: ModelRef = { providerID: providerFor(route.model), id: route.model }
  if (route.effort) model.variant = route.effort
  return model
}

function modelRow(route: ResolvedRoute, provider: string) {
  const rate = rateFor(route)
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
 * `OPENCODE_CONFIG_CONTENT`: the three providers with every `opencode`-wire route's model and its fallback's, each with
 * every effort variant it can run (`EFFORTS`; a Sonnet has no `none`), so a run whose arm moves an agent route to
 * another of these models or effort opens its session on the running server, without a restart. Each model's row takes
 * the rate and output limit of the first route naming it (the table names one rate per model). The
 * attribution plugin (`options.plugin`, an absolute directory), no updates, no share. The only credential is the door
 * token, by reference to the server's env.
 * The Anthropic leg sends `x-agw-fallback: none`: with no credit pool left the gateway answers a 402 and the route's own
 * fallback takes over, rather than paying for Claude on IU.
 * The server policy is deny by default as the sessions' are (`basePolicy`: catch-all deny, then the read-only tools), so
 * a session created without rules, or by something other than the host, is not allow-all. A session's own rules come
 * after it and win (measured on 2.0.32, `test/live-permissions.test.ts`). Unattended sessions must never block on a
 * question: `question` is denied and so is `external_directory` (its base policy is `ask`). An agent's own rules go in
 * its location's `opencode.json` (`AgentDefinition.config`).
 */
export function buildServerConfig(options: { plugin?: string } = {}): Record<string, unknown> {
  const models: Record<string, Record<string, unknown>> = {
    [PROVIDER_ANTHROPIC]: {},
    [PROVIDER_CHAT]: {},
    [PROVIDER_RESPONSES]: {},
  }
  for (const route of opencodeRoutes()) {
    const provider = providerFor(route.model)
    const rows = models[provider] as Record<string, unknown>
    rows[route.model] ??= modelRow(route, provider)
  }
  return {
    update: 'disable',
    share: 'disabled',
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
