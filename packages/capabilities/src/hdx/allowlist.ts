/**
 * The ClickStack MCP tools `hdx.query` will run, and so the only ones an agent can reach: read-only by the server's
 * own `readOnlyHint` annotation, listed by name (checked against the live `tools/list`, 2026-10-29), minus
 * `CLI_ONLY_READ_TOOLS`. An allowlist, not a denylist: a tool added by a ClickStack upgrade is refused until it is read
 * and added here. `hdx.live.test.ts` compares the lists with the live annotations.
 */
export const AGENT_READ_TOOLS = [
  'clickstack_list_sources',
  'clickstack_describe_source',
  'clickstack_list_metrics',
  'clickstack_describe_metric',
  'clickstack_get_alert',
  'clickstack_get_dashboard',
  'clickstack_get_dashboard_tile',
  'clickstack_search_dashboards',
  'clickstack_query_tile',
  'clickstack_query_tiles',
  'clickstack_service_health',
  'clickstack_timeseries',
  'clickstack_table',
  'clickstack_search',
  'clickstack_event_patterns',
  'clickstack_event_deltas',
  'clickstack_emerging_signals',
  'clickstack_get_saved_search',
  'clickstack_trace_waterfall',
  'clickstack_trace_top_time_consuming_operations',
] as const

/**
 * Annotated read-only by the server, but kept from agents: `clickstack_sql` runs raw ClickHouse SQL under the
 * connection's credentials, and the annotation is the server's claim, not a guarantee the database enforces (it reaches
 * any table, system tables included); `clickstack_get_webhook` is the webhook destinations, the channel configuration an
 * alert notifies through. Reachable through `hdx.write` (CLI only).
 */
export const CLI_ONLY_READ_TOOLS = ['clickstack_sql', 'clickstack_get_webhook'] as const

export type AgentReadTool = (typeof AGENT_READ_TOOLS)[number]

const AGENT_READ = new Set<string>(AGENT_READ_TOOLS)

export const isAgentReadTool = (name: string): name is AgentReadTool => AGENT_READ.has(name)

/** The server's `readOnlyHint: false` set (informational: the gate on `hdx.write` is `!isAgentReadTool`). */
export const MUTATING_TOOLS = [
  'clickstack_save_source',
  'clickstack_delete_source',
  'clickstack_save_webhook',
  'clickstack_delete_webhook',
  'clickstack_save_alert',
  'clickstack_save_dashboard',
  'clickstack_patch_dashboard',
  'clickstack_delete_dashboard',
  'clickstack_save_saved_search',
] as const

/**
 * The capabilities a grant to an agent (the tool gate) may draw from. Structural, not prose: a test pins that none is
 * mutating and that every `hdx.*` capability is in exactly one of this list and `CLI_ONLY_HDX`, so a new capability must
 * be classified to pass.
 */
export const AGENT_SAFE_HDX = ['hdx.tools', 'hdx.guide', 'hdx.query', 'hdx.link'] as const

/** Never granted to an agent: `hdx.write` changes ClickStack and reaches the tools kept from agents; `hdx.rest` is a generic REST GET. */
export const CLI_ONLY_HDX = ['hdx.rest', 'hdx.write'] as const
