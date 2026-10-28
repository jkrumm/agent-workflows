import type { Env } from './config.ts'
import type { HttpOptions } from './http.ts'
import { iuAnthropic } from './iu-anthropic.ts'
import { iuDecision } from './iu-decision.ts'
import { iuOpenai } from './iu-openai.ts'
import type { IuTransports } from './port.ts'

export type { Env, IuConfig } from './config.ts'
export { iuConfig } from './config.ts'
export { type HttpOptions, isBalanceError } from './http.ts'
export { iuAnthropic } from './iu-anthropic.ts'
export { iuDecision } from './iu-decision.ts'
export { iuOpenai } from './iu-openai.ts'
export type * from './port.ts'

/** The production adapters. Credentials are read from `env` on each call, so building this never fails. */
export function iuTransports(options: HttpOptions & { env?: Env } = {}): IuTransports {
  return { openai: iuOpenai(options), anthropic: iuAnthropic(options), decision: iuDecision(options) }
}
