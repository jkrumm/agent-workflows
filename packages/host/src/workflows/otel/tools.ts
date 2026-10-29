import { createHash } from 'node:crypto'
import type { Json } from '@agent-workflows/runtime'
import { z } from 'zod'
import { canonicalJson } from '../../canonical.ts'
import type { ToolCallRecord, ToolGrant } from '../../tool-gate/index.ts'
import { asRecord } from '../research/util.ts'
import { Query } from './schema.ts'

/**
 * The otel agent's tools, as the model sees them, and the `hdx.*` capability each runs. Only agent-safe capabilities
 * (`AGENT_SAFE_HDX`): the gate refuses a grant of anything else. `hdx.link` is left out: no finding carries a URL.
 */
export const OTEL_TOOLS = {
  hdx_tools: 'hdx.tools',
  hdx_guide: 'hdx.guide',
  hdx_query: 'hdx.query',
} as const satisfies Record<string, string>

/** ClickStack tools that read telemetry; the rest of `AGENT_READ_TOOLS` is metadata (sources, dashboards, alerts). */
export const DATA_TOOLS: ReadonlySet<string> = new Set([
  'clickstack_timeseries',
  'clickstack_table',
  'clickstack_search',
  'clickstack_event_patterns',
  'clickstack_event_deltas',
  'clickstack_emerging_signals',
  'clickstack_service_health',
  'clickstack_trace_waterfall',
  'clickstack_trace_top_time_consuming_operations',
  'clickstack_query_tile',
  'clickstack_query_tiles',
])

/** What the `tools` step journals: the run's calls, in the order they started. */
export const Calls = z.object({ calls: z.array(Query) })
export type Calls = z.output<typeof Calls>

const digest = (args: Record<string, Json>) =>
  createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 12)

/** Rows of a tool answer: the `rows` or `data` of a ClickHouse-shaped `result`, or a list under a known key. */
export function rowsOf(text: string, truncated = false): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A cut answer is not JSON; if it is cut inside a non-empty `data` list, there is at least one row.
    return truncated && /"data":\s*\[\s*\{/.test(text) ? 1 : undefined
  }
  if (Array.isArray(value)) return value.length
  const top = asRecord(value as Json)
  for (const holder of [asRecord(top.result), top]) {
    if (typeof holder.rows === 'number' && Number.isInteger(holder.rows)) return holder.rows
    for (const key of ['data', 'rows', 'results', 'series', 'events', 'services']) {
      const list = holder[key]
      if (Array.isArray(list)) return list.length
    }
  }
  return undefined
}

/** Whether a recorded call is a query that read telemetry, worked, and returned rows: what a finding may rest on. */
export const returnedRows = (query: Query) =>
  query.ok && query.target !== undefined && DATA_TOOLS.has(query.target) && (query.rows ?? 0) > 0

/**
 * The calls of one run. A call gets its id when it STARTS (`q<n>` for the n-th `hdx_query`, in the order they reach
 * the gate; a retried or resumed `tools` step prefixes its attempt, `q2.<n>`, so an id never means two calls), and the
 * agent is shown that id with the answer (the grant's label), so what it cites is what was recorded. `hdx_tools` and
 * `hdx_guide` get `t<n>` ids and no label: reading about the tools is not a query. Once `take` or `close` has run the
 * recorder is closed: a late hook (a call that outlived the step) changes nothing and nothing is kept for it.
 */
export function runCalls() {
  let attempt = 1
  let queries = 0
  let tools = 0
  let closed = false
  const calls: Query[] = []
  const ids = new Map<string, string>()
  /** Place of each call in the run: a query's at its start, a tool listing's at its end. */
  const place = new Map<string, number>()

  const queryId = () => `q${attempt > 1 ? `${attempt}.` : ''}${++queries}`

  /** The tools step's `attempt`: a later one numbers its own queries apart from the earlier attempt's. */
  const begin = (n: number) => {
    if (n === attempt) return
    attempt = n
    queries = 0
  }

  const onStart: NonNullable<ToolGrant['onStart']> = (call) => {
    if (closed || call.tool !== 'hdx_query') return undefined
    const id = queryId()
    ids.set(`query ${id}`, id)
    place.set(id, place.size)
    return `query ${id}`
  }

  const onCall: NonNullable<ToolGrant['onCall']> = (call) => {
    if (closed) return
    const id = (call.label && ids.get(call.label)) || `t${++tools}`
    if (!place.has(id)) place.set(id, place.size)
    calls.push(recordOf(call, id))
  }

  return {
    begin,
    onStart,
    onCall,
    /** The recorded calls in start order; closes the recorder. */
    take(): Query[] {
      closed = true
      return [...calls].sort((a, b) => (place.get(a.id) ?? 0) - (place.get(b.id) ?? 0))
    },
    close() {
      closed = true
      calls.length = 0
    },
  }
}

/** One gate call as a query record. Never throws. */
export function recordOf(call: ToolCallRecord, id: string): Query {
  const base = { id, tool: call.tool, argsDigest: digest(call.args) }
  const target = call.tool === 'hdx_query' && typeof call.args.tool === 'string' ? call.args.tool : undefined
  const head = { ...base, ...(target ? { target } : {}) }
  if (!call.outcome.ok) return { ...head, ok: false, chars: 0, error: call.outcome.error.slice(0, 300) }
  const result = asRecord(call.outcome.result)
  const text = typeof result.text === 'string' ? result.text : JSON.stringify(call.outcome.result)
  const chars = typeof result.totalChars === 'number' ? result.totalChars : text.length
  if (result.isError === true) return { ...head, ok: false, chars, error: text.slice(0, 300) }
  const rows = rowsOf(text, result.truncated === true)
  return { ...head, ok: true, chars, ...(rows === undefined ? {} : { rows }) }
}

/**
 * The otel step's grant: its three tools, the run's environment pinned (the agent's own `env` argument is overwritten,
 * and the plugin does not offer one), and the hooks that number and record every call.
 */
export function otelGrant(
  calls: Pick<ReturnType<typeof runCalls>, 'onStart' | 'onCall'>,
  env: 'local' | 'prod',
): Pick<ToolGrant, 'tools' | 'fixed' | 'onStart' | 'onCall'> {
  return { tools: OTEL_TOOLS, fixed: { env }, onStart: calls.onStart, onCall: calls.onCall }
}

const CITED = /\bq\d+(?:\.\d+)?\b/gi

/**
 * Whether a finding's evidence rests on this run's queries: it names (`q3`) at least one query that read telemetry,
 * worked and returned rows. Nothing else grounds it: a trace id, a quote or a column name in the text proves
 * nothing, and a failed, empty, metadata or unknown query supports no finding.
 */
export function isGrounded(evidence: string | undefined, calls: readonly Query[]): boolean {
  if (!evidence) return false
  const solid = new Set(calls.filter(returnedRows).map((q) => q.id))
  return [...evidence.matchAll(CITED)].some((m) => solid.has(m[0].toLowerCase()))
}
