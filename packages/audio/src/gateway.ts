import type { Attribution } from '@agent-workflows/runtime'

export type { Attribution }

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

/**
 * The gateway's attribution headers for one call, the same set as `gatewayHeaders` of `packages/capabilities` (not a
 * dependency of audio). The session is the root run, so a run tree stays on one credit pool. A value that is absent
 * or not printable ASCII up to 200 characters is left out. `call` names the route the call dispatches on
 * (`x-agw-route`) and its effort (`x-agw-effort`), which the gateway stores on the usage row; each under the same filter.
 */
export function gatewayHeaders(attribution: Attribution | undefined, call: CallHeaders = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (attribution) {
    for (const [key, name] of Object.entries(NAMES) as [keyof Attribution, string][]) {
      const value = attribution[key]
      if (typeof value === 'string' && HEADER_VALUE.test(value)) headers[name] = value
    }
  }
  if (call.route !== undefined && HEADER_VALUE.test(call.route)) headers['x-agw-route'] = call.route
  if (call.effort !== undefined && HEADER_VALUE.test(call.effort)) headers['x-agw-effort'] = call.effort
  return headers
}

/** The route id and effort of one call. */
export interface CallHeaders {
  route?: string
  effort?: string
}

/**
 * Calls agw prices itself (per minute, per character, per image): the gateway writes no row for them and agw's run
 * record carries the cost. Text chat calls never send it: the gateway writes those rows.
 */
export const CALLER_USAGE = { 'x-agw-usage': 'caller' } as const
