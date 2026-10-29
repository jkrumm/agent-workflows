# Otel (concept N7)

`agw otel "<investigation>" [--env prod|local] [--since 2h | <from>/<to>]` investigates traces, logs and metrics in
ClickStack/HyperDX and answers in agent-gateway's `otel` shape: `status` `healthy|degraded|errors`, `environment`,
`timeRange`, `findings [{service, summary, severity, evidence?, unverified}]`, `recommendations`. Changed from the
legacy tool: `hyperdx` is typed (`{connected, reason?}`), and the answer adds `queries` (every tool call of the run:
`id`, `tool`, `target`, `argsDigest`, `ok`, `error?`, `rows?`, `chars`) and `warnings`. `--since` is a duration ending
now (`30m`, `2h`, `3d`) or an absolute `<from>/<to>` of strict ISO-8601 instants with a zone (`2026-10-27T08:00:00Z`;
dates alone, local times, impossible days and a reversed range are refused); without it the agent chooses (the run's journaled
start time is in its prompt, since the agent has no clock).

- **The agent** (`agents/otel`, route `otel.agent`: deepseek on OpenCode, `AGENT_FALLBACK`) holds three tools through the
  tool gate (`packages/host/README.md` §Tool gate): `hdx_tools`, `hdx_guide`, `hdx_query`, mapped to `hdx.tools|guide|query` (`otelGrant`). No
  shell, no `query.py`, and no SQL: `clickstack_sql` is outside `AGENT_READ_TOOLS` (CLI-only, see the capabilities
  README), so the builder tools are the whole path (legacy's "SQL last" step is gone, deliberately). `hdx.link` is not
  granted: no finding carries a URL.
- **The environment is the run's.** The grant carries `fixed: { env }`; the gate sets it on every call after the agent's
  own arguments, and the plugin offers no `env` argument. The agent cannot choose or switch it; `environment` in the
  answer is the input's, not the agent's.
- **Query ids are the agent's citations.** The grant's `onStart` hook numbers each `hdx_query` when the call starts (issue
  order: `q1`, `q2`, ...) and the gate sends that label back with the answer, so the agent's tool shows `query q3: ...`
  and what it cites is what was recorded. `hdx_tools` and `hdx_guide` are `t<n>` and carry no label (reading about the
  tools is not a query). The recorder is per run (no global state): `onCall` writes the query's record (`tool`,
  `target`, `argsDigest`, `ok`, `rows`, `chars`) and the `tools` step journals the list, so a replay grounds the same
  way. A retried or resumed `tools` step numbers its queries `q<attempt>.<n>` (`q2.1`), so an id never means two calls;
  calls made before a host restart are lost, the resumed agent's earlier ids match nothing, and those findings are
  flagged, never dropped. A hook that fires after the step has taken its calls is ignored (nothing re-inserted).
- **Grounding** (`assemble`, in code). A finding is grounded when its `evidence` names at least one query of this run
  that read telemetry (`clickstack_table|timeseries|search|event_*|service_health|trace_*|query_tile(s)`), worked and
  returned rows (`rows > 0`, read from the answer's `result.rows`/`data` or a `services` list; an answer cut inside a
  non-empty `data` list counts as at least one). Nothing in the evidence text itself grounds it (a trace id, a quote,
  a date or a column name would ground a hallucination). Otherwise it stays in the answer with `unverified: true` and
  the run carries a warning. Quoted excerpts in evidence add a warning too.
- **Untrusted output.** Summaries, evidence and recommendations come from an agent that read logs any observed system
  can write: the answer carries an `untrusted` note, and the calling session reads it without obeying it.
- **Status is cross-checked.** `healthy` needs a query that returned rows (see above); without one the answer is
  `degraded` with a warning (health nobody looked at, or an empty window, is not health). `degraded` or `errors` with
  no such query keeps its status and adds a warning. `hyperdx.connected` is true when any call was answered.
- **One re-ask** (`otel:reask`, the same session) when the answer is not the findings JSON, then `invalid_output`.
- **Scorer** (`scorer.ts`): `valid`, `status` (match), `facts` (judged: one `decide` boolean per reference fact),
  `grounded` (the share of findings not flagged `unverified`; only when the output has `queries`, so the legacy arm is scored by the
  same function). `pass`: valid, status matches and every fact stated. Cases are plain eval cases in
  `$AGW_EVAL_DIR/otel/cases.jsonl` (`{id, input: {investigation, env, since}, reference: {status, facts}}`);
  `scripts/eval-legacy/otel.ts` runs agent-gateway's MCP `otel` tool per case and appends scored rows to
  `<evalDir>/otel/legacy-runs.jsonl`.

## Route

Model and rate: `packages/routes/src/table/otel.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `otel.agent` | `otel` (Sonnet on Max; none on IU) | opencode |
