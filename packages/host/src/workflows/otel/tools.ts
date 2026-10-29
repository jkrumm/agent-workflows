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

/** Text kept per call, and per run, to match evidence against: bounded, since the `tools` step journals it. */
const TEXT_PER_CALL = 30_000
const TEXT_PER_RUN = 300_000

/** A recorded call: the digest the output carries, and the (normalized, bounded) answer text grounding reads. */
export const Recorded = z.object({ query: Query, text: z.string(), data: z.boolean() })
export type Recorded = z.output<typeof Recorded>

/** What the `tools` step journals: the run's calls in the order they were answered. */
export const Calls = z.object({ calls: z.array(Recorded) })
export type Calls = z.output<typeof Calls>

export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

const digest = (args: Record<string, Json>) =>
  createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 12)

/** Rows of a tool answer when it is a JSON list, or an object holding one; undefined when the text says no. */
export function rowsOf(text: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (Array.isArray(value)) return value.length
  const object = asRecord(value as Json)
  for (const key of ['rows', 'data', 'results', 'series', 'events']) {
    const list = object[key]
    if (Array.isArray(list)) return list.length
  }
  return undefined
}

/**
 * One gate call as a record, `id` given by the store: `q<n>` for the n-th `hdx_query` answered, `t<n>` for the
 * n-th `hdx_tools` or `hdx_guide` (reading about the tools is not a query). `budget` is the text left for the run.
 */
export function recordOf(call: ToolCallRecord, id: string, budget: number): Recorded {
  const base = { id, tool: call.tool, argsDigest: digest(call.args) }
  const target = typeof call.args.tool === 'string' && call.tool === 'hdx_query' ? call.args.tool : undefined
  const query = (extra: Partial<Query>): Query => ({
    ...base,
    ...(target ? { target } : {}),
    ok: false,
    chars: 0,
    ...extra,
  })
  if (!call.outcome.ok) {
    return { query: query({ error: call.outcome.error.slice(0, 300) }), text: '', data: false }
  }
  const result = asRecord(call.outcome.result)
  const text = typeof result.text === 'string' ? result.text : JSON.stringify(call.outcome.result)
  const failed = result.isError === true
  const chars = typeof result.totalChars === 'number' ? result.totalChars : text.length
  const rows = failed ? undefined : rowsOf(text)
  return {
    query: query({
      ok: !failed,
      chars,
      ...(failed ? { error: text.slice(0, 300) } : {}),
      ...(rows === undefined ? {} : { rows }),
    }),
    text: failed ? '' : normalize(text).slice(0, Math.max(0, Math.min(TEXT_PER_CALL, budget))),
    data: !failed && target !== undefined && DATA_TOOLS.has(target),
  }
}

/** Calls per run, held until the run's `tools` step reads them (and the step journals them). */
export type CallStore = {
  /** The grant's hook for one run. */
  hook(runId: string): ToolGrant['onCall']
  /** The run's calls so far, answered order; drops them. */
  take(runId: string): Recorded[]
  clear(runId: string): void
}

export function callStore(): CallStore {
  const runs = new Map<string, Recorded[]>()
  return {
    hook: (runId) => (call) => {
      const calls = runs.get(runId) ?? []
      runs.set(runId, calls)
      const used = calls.reduce((sum, c) => sum + c.text.length, 0)
      const asked = call.tool === 'hdx_query'
      const nth = calls.filter((c) => (c.query.tool === 'hdx_query') === asked).length + 1
      calls.push(recordOf(call, `${asked ? 'q' : 't'}${nth}`, TEXT_PER_RUN - used))
    },
    take: (runId) => {
      const calls = runs.get(runId) ?? []
      runs.delete(runId)
      return calls
    },
    clear: (runId) => void runs.delete(runId),
  }
}

/**
 * The otel step's grant: its three tools, the run's environment pinned (the agent's own `env` argument is overwritten,
 * and the plugin does not offer one), and the hook that records every call.
 */
export function otelGrant(
  store: CallStore,
  runId: string,
  env: 'local' | 'prod',
): Pick<ToolGrant, 'tools' | 'fixed' | 'onCall'> {
  return { tools: OTEL_TOOLS, fixed: { env }, onCall: store.hook(runId) }
}

const HEX_ID = /\b[0-9a-f]{16,}\b/g
const QUOTED = /"([^"]{8,})"|'([^']{8,})'|`([^`]{8,})`/g
/** A dotted, slashed or colon-joined identifier of 8+ characters: `http.status_code`, `/api/v1/users`, `db:main`. */
const IDENT = /[\w]+(?:[./:-][\w]+)+/g
const CITED = /\bq(\d+)\b/gi

/**
 * Whether a finding's evidence rests on this run's queries. It does when it names a query of the run that worked
 * (`q3`; `hdx_query` calls only), or when something specific in it (a hex id, a quoted excerpt, a dotted or pathlike identifier of 8+
 * characters, or the whole text) appears in the answer of a query that worked. An evidence-less finding, or one that
 * names only a query that failed or does not exist, rests on nothing.
 */
export function isGrounded(evidence: string | undefined, calls: readonly Recorded[]): boolean {
  if (!evidence?.trim()) return false
  const worked = new Map(calls.filter((c) => c.query.ok && c.query.tool === 'hdx_query').map((c) => [c.query.id, c]))
  for (const match of evidence.matchAll(CITED)) if (worked.has(`q${match[1]}`)) return true
  const haystacks = [...worked.values()].map((c) => c.text).filter(Boolean)
  if (haystacks.length === 0) return false
  const found = (needle: string) => needle.length >= 8 && haystacks.some((text) => text.includes(needle))
  const text = normalize(evidence)
  const needles = [
    text,
    ...(text.match(HEX_ID) ?? []),
    ...[...evidence.matchAll(QUOTED)].map((m) => normalize(m[1] ?? m[2] ?? m[3] ?? '')),
    ...(text.match(IDENT) ?? []),
  ]
  return needles.some(found)
}
