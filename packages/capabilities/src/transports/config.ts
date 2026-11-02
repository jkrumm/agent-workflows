import { fail } from '../errors.ts'

export type Env = Record<string, string | undefined>

export interface GatewayConfig {
  /** The host's API secret, which the gateway accepts as the caller `agw`. */
  token: string
  anthropicBase: string
  openaiBase: string
  decisionBase: string
  replicateBase: string
}

/**
 * The local inference gateway from the environment only (`AGW_GATEWAY_URL`, an origin, and `AGW_API_SECRET`). The
 * gateway mirrors IU's path layout, so every wire's base is derived here and never hardcoded. Messages never echo a
 * value.
 */
export function gatewayConfig(env: Env): GatewayConfig {
  const token = env.AGW_API_SECRET?.trim()
  const raw = env.AGW_GATEWAY_URL?.trim()
  if (!raw) throw fail('NOT_CONFIGURED', 'AGW_GATEWAY_URL is not set')
  if (!token) throw fail('NOT_CONFIGURED', 'AGW_API_SECRET is not set')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail('NOT_CONFIGURED', 'AGW_GATEWAY_URL is not a URL')
  }
  // An origin only: a path (an old IU base ending in `/anthropic`) would double every wire's prefix.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
    throw fail('NOT_CONFIGURED', 'AGW_GATEWAY_URL must be an http(s) origin, without a path')
  }
  const origin = url.origin
  return {
    token,
    anthropicBase: `${origin}/anthropic`,
    openaiBase: `${origin}/openai/v1`,
    decisionBase: `${origin}/decisions/v1`,
    replicateBase: `${origin}/replicate/v1`,
  }
}
