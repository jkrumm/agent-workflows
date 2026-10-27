import { fail } from '../errors.ts'

export type Env = Record<string, string | undefined>

export interface IuConfig {
  apiKey: string
  openaiBase: string
  anthropicBase: string
  decisionBase: string
}

/**
 * IU credentials from the environment only (`IU_API_KEY`, `IU_BASE_URL`). The base ends in
 * `/anthropic`; the other wires are the same host, derived here and never hardcoded. Messages never
 * echo a value.
 */
export function iuConfig(env: Env): IuConfig {
  const apiKey = env.IU_API_KEY?.trim()
  const base = env.IU_BASE_URL?.trim().replace(/\/+$/, '')
  if (!apiKey) throw fail('NOT_CONFIGURED', 'IU_API_KEY is not set')
  if (!base) throw fail('NOT_CONFIGURED', 'IU_BASE_URL is not set')
  if (!base.endsWith('/anthropic')) throw fail('NOT_CONFIGURED', 'IU_BASE_URL must end in /anthropic')
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    throw fail('NOT_CONFIGURED', 'IU_BASE_URL is not a URL')
  }
  return {
    apiKey,
    anthropicBase: base,
    openaiBase: `${base.slice(0, -'/anthropic'.length)}/openai/v1`,
    decisionBase: `${origin}/decisions/v1`,
  }
}
