import type { Attribution } from '../context.ts'

/**
 * Printable ASCII, 1–200 characters, no space at either end: anything else `fetch` may refuse or trim into another
 * value, and a bad project name must not fail a call.
 */
const HEADER_VALUE = /^(?! )[\x20-\x7e]{1,200}(?<! )$/

const NAMES = {
  rootId: 'x-agw-session',
  runId: 'x-agw-run-id',
  workflow: 'x-agw-workflow',
  step: 'x-agw-step',
  purpose: 'x-agw-purpose',
  project: 'x-agw-project',
  workspace: 'x-agw-workspace',
  traceparent: 'traceparent',
  origin: 'x-agw-origin',
  routeFallback: 'x-agw-route-fallback',
} as const satisfies Record<keyof Attribution, string>

/** What the call itself is, beside who it is for: the route id it dispatches on and the effort it asks for. */
export interface CallLabels {
  route?: string
  effort?: string
}

const CALL_NAMES = { route: 'x-agw-route', effort: 'x-agw-effort' } as const satisfies Record<keyof CallLabels, string>

/**
 * The gateway's attribution headers for one call. The session is the root run, so every call of a run tree binds to
 * one credit pool. `call` adds `x-agw-route` and `x-agw-effort`, which the gateway stores on the usage row. An absent
 * value, one with a space at either end (or only spaces), or one that is not printable ASCII up to 200 characters, is
 * left out.
 */
export function gatewayHeaders(attribution: Attribution | undefined, call?: CallLabels): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, name] of Object.entries(CALL_NAMES) as [keyof CallLabels, string][]) {
    const value = call?.[key]
    if (typeof value === 'string' && HEADER_VALUE.test(value)) headers[name] = value
  }
  if (!attribution) return headers
  for (const [key, name] of Object.entries(NAMES) as [keyof Attribution, string][]) {
    const value = attribution[key]
    if (typeof value === 'string' && HEADER_VALUE.test(value)) headers[name] = value
  }
  return headers
}
