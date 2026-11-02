-- A step with no usage now records cost 0 (known free), so `cost is not null` no longer marks a step worth posting:
-- only tokens or a positive cost do. The index follows the outbox query (`UsageOutbox.claim`).
drop index {{schema}}.steps_argo_outbox;
create index steps_argo_outbox on {{schema}}.steps (finished_at)
  where argo_synced_at is null and argo_error is null and status in ('done', 'failed', 'cancelled')
    and (tokens_input > 0 or tokens_output > 0 or tokens_cache_read > 0 or tokens_cache_write > 0
      or tokens_reasoning > 0 or cost > 0);
