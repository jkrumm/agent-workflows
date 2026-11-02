-- A step that ended done with no usage now records cost 0 (known free), so `cost is not null` no longer marks a step
-- worth posting: only tokens or a positive cost do. The new index follows the outbox query (`UsageOutbox.claim`); it is
-- built under a new name first so the outbox never runs without one, then the old one goes.
create index steps_usage_outbox on {{schema}}.steps (finished_at)
  where argo_synced_at is null and argo_error is null and status in ('done', 'failed', 'cancelled')
    and (tokens_input > 0 or tokens_output > 0 or tokens_cache_read > 0 or tokens_cache_write > 0
      or tokens_reasoning > 0 or cost > 0);
drop index if exists {{schema}}.steps_argo_outbox;
