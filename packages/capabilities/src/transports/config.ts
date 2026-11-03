import { fail } from '../errors.ts'

export type Env = Record<string, string | undefined>

/** Every wire's base on the gateway; no credential. */
export interface GatewayBases {
  anthropicBase: string
  openaiBase: string
  decisionBase: string
  replicateBase: string
}

export interface GatewayConfig extends GatewayBases {
  /** The host's API secret, which the gateway accepts as the caller `agw`. For the host's own transports only. */
  token: string
}

/**
 * The local inference gateway from the environment only (`AGW_GATEWAY_URL`, an origin, and `AGW_API_SECRET`): the
 * host's own transports. A child process gets a door token of its own, never this token.
 * Messages never echo a value.
 */
export function gatewayConfig(env: Env): GatewayConfig {
  const bases = gatewayBases(env)
  const token = env.AGW_API_SECRET?.trim()
  if (!token) throw fail('NOT_CONFIGURED', 'AGW_API_SECRET is not set')
  return { token, ...bases }
}

/**
 * Every wire's base from `AGW_GATEWAY_URL` (an http(s) origin, no default). The gateway mirrors IU's path layout, so
 * the bases are derived here and never hardcoded. Messages never echo a value.
 */
export function gatewayBases(env: Env): GatewayBases {
  const raw = env.AGW_GATEWAY_URL?.trim()
  if (!raw) throw fail('NOT_CONFIGURED', 'AGW_GATEWAY_URL is not set')
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
    anthropicBase: `${origin}/anthropic`,
    openaiBase: `${origin}/openai/v1`,
    decisionBase: `${origin}/decisions/v1`,
    replicateBase: `${origin}/replicate/v1`,
  }
}
