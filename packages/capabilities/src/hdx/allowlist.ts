/**
 * The ClickStack MCP tools `hdx.query` will run: every tool the server annotates `readOnlyHint: true`, listed by name
 * (checked against the live `tools/list`, 2026-10-29). An allowlist, not a denylist: a tool added by a ClickStack
 * upgrade is refused until it is read and added here. `hdx.live.test.ts` compares this list with the live annotations.
 */
export const READ_ONLY_TOOLS = [
  'clickstack_list_sources',
  'clickstack_describe_source',
  'clickstack_list_metrics',
  'clickstack_describe_metric',
  'clickstack_get_alert',
  'clickstack_get_webhook',
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
  'clickstack_sql',
  'clickstack_get_saved_search',
  'clickstack_trace_waterfall',
  'clickstack_trace_top_time_consuming_operations',
] as const

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number]

const READ_ONLY = new Set<string>(READ_ONLY_TOOLS)

export const isReadOnlyTool = (name: string): name is ReadOnlyTool => READ_ONLY.has(name)

/** The tools `hdx.write` is known to be for (the server's `readOnlyHint: false` set; informational, the gate is `!isReadOnlyTool`). */
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
