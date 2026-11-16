-- What a research tool call says about the web chain, so the fetch's tuning questions (top failing hosts, which leg
-- answers, the cache hit rate, per-leg latency, how often Tavily rescues) are one query each. Expand only: every column
-- is nullable, no reader of an older release depends on one, and rows before this migration keep them null.
-- `host` is a hostname and nothing else (a URL can carry a secret in its path or query); `legs` holds leg names,
-- timings and outcomes, never a URL.
alter table {{schema}}.research_tool_calls
  add column host text,
  -- web_fetch: the leg that answered (direct, browser, tavily-extract); null on a failure and for other tools.
  add column via text,
  add column cached boolean,
  -- Wall time of the call as the gate measured it, every tool and every outcome.
  add column wall_ms integer,
  -- web_fetch: [{ leg, ms, outcome, waitMs? }] in the order the chain read them (empty for a cached answer).
  add column legs jsonb,
  -- web_fetch: why the page turned the reader away (`blocked (<reason>)` in the failure), as a column.
  add column blocked_reason text;
create index research_tool_calls_created on {{schema}}.research_tool_calls (created_at);
