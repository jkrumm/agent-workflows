-- Cache writes as their own token bucket. Raw provider counts: `tokens_input` includes cache reads and writes.
alter table {{schema}}.steps add column tokens_cache_write bigint not null default 0;
alter table {{schema}}.runs
  add column tokens_cache_write bigint,
  add column unpriced_calls integer,
  add column tool_calls integer,
  -- Failed runPost deliveries; past the runtime's cap the run is marked delivered anyway (logged).
  add column post_hooks_attempts integer not null default 0;

-- Argo outbox: a claim with expiry, so no transaction spans the post; a permanent failure quarantines the step.
alter table {{schema}}.steps
  add column argo_claim text,
  add column argo_claimed_until timestamptz,
  add column argo_error text;

drop index {{schema}}.steps_argo_outbox;
create index steps_argo_outbox on {{schema}}.steps (finished_at)
  where argo_synced_at is null and argo_error is null and status in ('done', 'failed', 'cancelled')
    and (tokens_input > 0 or tokens_output > 0 or tokens_cache_read > 0 or tokens_cache_write > 0
      or tokens_reasoning > 0 or cost is not null);

-- History reads per workflow (limits: the normal of a workflow is its finished runs).
create index runs_workflow_done on {{schema}}.runs (workflow, finished_at) where status = 'done';
