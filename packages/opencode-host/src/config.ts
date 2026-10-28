import { type Rate, type ResolvedRoute, type RouteId, resolveRoute, routeIds } from '@agent-workflows/routes'
import type { ModelRef } from './client.ts'

type Env = Record<string, string | undefined>

/** OpenCode provider ids the server config defines. Both go through IU; the key never leaves the server env. */
export const PROVIDER_ANTHROPIC = 'iu-anthropic'
export const PROVIDER_CHAT = 'iu-chat'

/** IU endpoints from `IU_API_KEY` and `IU_BASE_URL` (the base ends in `/anthropic`, as for the capabilities). */
export function iuFromEnv(env: Env = process.env): { key: string; anthropicBase: string; openaiBase: string } {
  const key = env.IU_API_KEY?.trim()
  const base = env.IU_BASE_URL?.trim().replace(/\/+$/, '')
  if (!key) throw new Error('IU_API_KEY is not set')
  if (!base?.endsWith('/anthropic')) throw new Error('IU_BASE_URL is not set or does not end in /anthropic')
  return { key, anthropicBase: `${base}/v1`, openaiBase: `${base.slice(0, -'/anthropic'.length)}/openai/v1` }
}

/** The `opencode`-wire routes, resolved with `AGW_ROUTES` applied. */
export function opencodeRoutes(env: Env = process.env): ResolvedRoute[] {
  return routeIds()
    .map((id) => resolveRoute(id, env))
    .filter((route) => route.wire === 'opencode')
}

/**
 * Which IU leg serves a model. Read from the table: a single-call route on the same model names its wire. Without
 * one, a `claude-` model goes the native Anthropic way and anything else the OpenAI-compatible chat way.
 */
function providerFor(model: string, env: Env): string {
  const siblings = routeIds().map((id) => resolveRoute(id, env))
  const wire = siblings.find((r) => r.model === model && r.wire !== 'opencode')?.wire
  if (wire === 'iu-anthropic') return PROVIDER_ANTHROPIC
  if (wire === 'iu-openai') return PROVIDER_CHAT
  return model.startsWith('claude-') ? PROVIDER_ANTHROPIC : PROVIDER_CHAT
}

/**
 * The rate OpenCode prices a route's messages with: the route's own, else the rate another route in the table
 * carries for the same model (a model's price does not depend on the wire). Null when the table has none: the host
 * then reports the step unpriced instead of OpenCode's cost 0.
 */
export function rateFor(route: ResolvedRoute, env: Env = process.env): Rate | null {
  if (route.rate) return route.rate
  for (const id of routeIds()) {
    const other = resolveRoute(id, env)
    if (other.model === route.model && other.rate) return other.rate
  }
  return null
}

/** The session's model for a route: provider, model and effort (as a variant) all from the route table. */
export function modelRef(routeId: RouteId, env: Env = process.env): { route: ResolvedRoute; model: ModelRef } {
  const route = resolveRoute(routeId, env)
  if (route.wire !== 'opencode') throw new Error(`route "${routeId}" is on the ${route.wire} wire, not opencode`)
  const model: ModelRef = { providerID: providerFor(route.model, env), id: route.model }
  if (route.effort) model.variant = route.effort
  return { route, model }
}

function modelRow(route: ResolvedRoute, provider: string, env: Env) {
  const rate = rateFor(route, env)
  return {
    name: route.model,
    // IU's gateway answers the `thinking-binding-controls` beta with a 503 for EU Haiku ids (agent-gateway,
    // measured 2026-10-14); without the binding, `thinking` is omitted (the model default).
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
    ...(route.effort ? { variants: [{ id: route.effort, settings: { reasoningEffort: route.effort } }] } : {}),
  }
}

/**
 * `OPENCODE_CONFIG_CONTENT`: the two IU providers with every `opencode`-wire route's model, no updates, no share.
 * Unattended sessions must never block on a question: `question` is denied and so is `external_directory` (its
 * base policy is `ask`). An agent's own rules go in its location's `opencode.json` (`AgentDefinition.config`).
 */
export function buildServerConfig(env: Env = process.env): Record<string, unknown> {
  const models: Record<string, Record<string, unknown>> = { [PROVIDER_ANTHROPIC]: {}, [PROVIDER_CHAT]: {} }
  for (const route of opencodeRoutes(env)) {
    const provider = providerFor(route.model, env)
    const rows = models[provider] as Record<string, unknown>
    const row = modelRow(route, provider, env)
    const existing = rows[route.model] as { variants?: unknown[] } | undefined
    if (existing && row.variants) existing.variants = [...(existing.variants ?? []), ...row.variants]
    else if (!existing) rows[route.model] = row
  }
  return {
    update: 'disable',
    share: 'disabled',
    permissions: [
      { action: 'question', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ],
    providers: {
      [PROVIDER_ANTHROPIC]: {
        package: 'aisdk:@ai-sdk/anthropic',
        name: 'IU (native Anthropic route)',
        settings: { baseURL: '{env:IU_ANTHROPIC_BASE}', apiKey: '{env:IU_KEY}' },
        models: models[PROVIDER_ANTHROPIC],
      },
      [PROVIDER_CHAT]: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'IU (OpenAI route, chat completions)',
        settings: { baseURL: '{env:IU_OPENAI_BASE}', apiKey: '{env:IU_KEY}' },
        models: models[PROVIDER_CHAT],
      },
    },
  }
}
