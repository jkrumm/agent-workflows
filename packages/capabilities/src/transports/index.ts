import { anthropicWire } from './anthropic.ts'
import type { Env } from './config.ts'
import type { HttpOptions } from './http.ts'
import { iuDecision } from './iu-decision.ts'
import { iuOpenai } from './iu-openai.ts'
import type { GatewayTransports } from './port.ts'

export { anthropicWire } from './anthropic.ts'
export type { Env, GatewayConfig } from './config.ts'
export { gatewayConfig } from './config.ts'
export { gatewayHeaders } from './headers.ts'
export { type HttpOptions, isBalanceError } from './http.ts'
export { iuDecision } from './iu-decision.ts'
export { iuOpenai } from './iu-openai.ts'
export type * from './port.ts'

/** The production adapters, all on the gateway. Its config is read from `env` on each call, so building this never fails. */
export function gatewayTransports(options: HttpOptions & { env?: Env } = {}): GatewayTransports {
  return { openai: iuOpenai(options), anthropic: anthropicWire(options), decision: iuDecision(options) }
}
