import {
  fallbackRoute,
  type Rate,
  type ResolvedRoute,
  type RouteId,
  resolveRoute,
  routeIds,
} from '@agent-workflows/routes'
import type { ModelRef } from './client.ts'
import { basePolicy } from './locations.ts'

type Env = Record<string, string | undefined>

/**
 * OpenCode provider ids the server config defines. The chat and Responses legs go through IU with the IU key; the
 * `claude-` leg goes straight to api.anthropic.com with a direct key (`ANTHROPIC_API_KEY`). Keys never leave the server env.
 */
export const PROVIDER_ANTHROPIC = 'anthropic-direct'
export const PROVIDER_CHAT = 'iu-chat'
/** IU's OpenAI endpoint over the Responses API: OpenAI's own models call tools only there (IU, 2026-10-28). */
export const PROVIDER_RESPONSES = 'iu-responses'

/** IU endpoints from `IU_API_KEY` and `IU_BASE_URL` (the base ends in `/anthropic`, as for the capabilities). */
export function iuFromEnv(env: Env = process.env): { key: string; anthropicBase: string; openaiBase: string } {
  const key = env.IU_API_KEY?.trim()
  const base = env.IU_BASE_URL?.trim().replace(/\/+$/, '')
  if (!key) throw new Error('IU_API_KEY is not set')
  if (!base?.endsWith('/anthropic')) throw new Error('IU_BASE_URL is not set or does not end in /anthropic')
  return { key, anthropicBase: `${base}/v1`, openaiBase: `${base.slice(0, -'/anthropic'.length)}/openai/v1` }
}

/** The `opencode`-wire routes, resolved with `AGW_ROUTES` applied, each followed by its fallback when it has one. */
export function opencodeRoutes(env: Env = process.env): ResolvedRoute[] {
  return routeIds()
    .map((id) => resolveRoute(id, env))
    .filter((route) => route.wire === 'opencode')
    .flatMap((route) => {
      const fallback = fallbackRoute(route)
      return fallback ? [route, fallback] : [route]
    })
}

/**
 * Which leg serves a model, by its family alone: no other route sharing the id can move it. OpenAI's own models
 * (`gpt-`) go the Responses way (an agent session needs tool calls, which they make only there), a `claude-` model the
 * direct Anthropic API, anything else the OpenAI-compatible chat way. A single-call route on the same model (Haiku on
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

/** The session's model for a route: provider, model and effort (as a variant) all from the route table. */
export function modelRef(routeId: RouteId, env: Env = process.env): { route: ResolvedRoute; model: ModelRef } {
  const route = resolveRoute(routeId, env)
  if (route.wire !== 'opencode') throw new Error(`route "${routeId}" is on the ${route.wire} wire, not opencode`)
  return { route, model: refFor(route) }
}

/** The session's model for a route's provider-balance fallback, or `undefined` when the route has none. */
export function fallbackModelRef(
  routeId: RouteId,
  env: Env = process.env,
): { route: ResolvedRoute; model: ModelRef } | undefined {
  const route = fallbackRoute(modelRef(routeId, env).route)
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
    // Kept from the IU gateway leg (it answered the `thinking-binding-controls` beta with a 503 for EU Haiku ids,
    // agent-gateway, measured 2026-10-14); without the binding, `thinking` is omitted (the model default).
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
    ...(route.effort ? { variants: [{ id: route.effort, settings: variantSettings(route.effort, provider) }] } : {}),
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
 * `OPENCODE_CONFIG_CONTENT`: the three providers with every `opencode`-wire route's model and its fallback's, no
 * updates, no share.
 * The server policy is deny by default as the sessions' are (`basePolicy`: catch-all deny, then the read-only tools), so
 * a session created without rules, or by something other than the host, is not allow-all. A session's own rules come
 * after it and win (measured on 2.0.32, `test/live-permissions.test.ts`). Unattended sessions must never block on a
 * question: `question` is denied and so is `external_directory` (its base policy is `ask`). An agent's own rules go in
 * its location's `opencode.json` (`AgentDefinition.config`).
 */
export function buildServerConfig(env: Env = process.env): Record<string, unknown> {
  const models: Record<string, Record<string, unknown>> = {
    [PROVIDER_ANTHROPIC]: {},
    [PROVIDER_CHAT]: {},
    [PROVIDER_RESPONSES]: {},
  }
  for (const route of opencodeRoutes(env)) {
    const provider = providerFor(route.model)
    const rows = models[provider] as Record<string, unknown>
    const row = modelRow(route, provider)
    const existing = rows[route.model] as { variants?: { id: string }[] } | undefined
    if (existing && row.variants) {
      // Routes sharing a model and effort (the fallbacks) share one variant.
      const known = new Set((existing.variants ?? []).map((v) => v.id))
      existing.variants = [...(existing.variants ?? []), ...row.variants.filter((v) => !known.has(v.id))]
    } else if (!existing) rows[route.model] = row
  }
  return {
    update: 'disable',
    share: 'disabled',
    permissions: [
      ...basePolicy(),
      { action: 'question', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ],
    providers: {
      [PROVIDER_ANTHROPIC]: {
        package: 'aisdk:@ai-sdk/anthropic',
        name: 'Anthropic API (direct key)',
        settings: { baseURL: 'https://api.anthropic.com/v1', apiKey: '{env:ANTHROPIC_API_KEY}' },
        models: models[PROVIDER_ANTHROPIC],
      },
      [PROVIDER_CHAT]: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'IU (OpenAI route, chat completions)',
        settings: { baseURL: '{env:IU_OPENAI_BASE}', apiKey: '{env:IU_KEY}' },
        models: models[PROVIDER_CHAT],
      },
      [PROVIDER_RESPONSES]: {
        package: 'aisdk:@ai-sdk/openai',
        name: 'IU (OpenAI route, Responses)',
        settings: { baseURL: '{env:IU_OPENAI_BASE}', apiKey: '{env:IU_KEY}' },
        models: models[PROVIDER_RESPONSES],
      },
    },
  }
}
