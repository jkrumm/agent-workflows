import type { Attribution } from '../context.ts'

/** Printable ASCII, 1–200 characters: anything else `fetch` may refuse, and a bad project name must not fail a call. */
const HEADER_VALUE = /^[\x20-\x7e]{1,200}$/

const NAMES = {
  rootId: 'x-agw-session',
  runId: 'x-agw-run-id',
  workflow: 'x-agw-workflow',
  step: 'x-agw-step',
  purpose: 'x-agw-purpose',
  project: 'x-agw-project',
  workspace: 'x-agw-workspace',
  traceparent: 'traceparent',
} as const satisfies Record<keyof Attribution, string>

/**
 * The gateway's attribution headers for one call. The session is the root run, so every call of a run tree binds to
 * one credit pool. An absent value, or one that is not printable ASCII up to 200 characters, is left out.
 */
export function gatewayHeaders(attribution: Attribution | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!attribution) return headers
  for (const [key, name] of Object.entries(NAMES) as [keyof Attribution, string][]) {
    const value = attribution[key]
    if (typeof value === 'string' && HEADER_VALUE.test(value)) headers[name] = value
  }
  return headers
}
