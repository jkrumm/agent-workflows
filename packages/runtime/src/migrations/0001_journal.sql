-- Journal: one row per run, one row per (run, step). Run-record columns are filled by the middleware.
create table {{schema}}.runs (
  id text primary key,
  workflow text not null,
  parent_id text references {{schema}}.runs (id) on delete cascade,
  root_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  purpose text not null,
  input jsonb not null,
  input_hash text not null,
  output jsonb,
  error text,
  error_kind text,
  idempotency_key text,
  traceparent text,
  trace_id text,
  lease_token text,
  -- Set by cancel on a running run; the process holding (or next claiming) the lease aborts and finalizes it.
  cancel_requested_at timestamptz,
  -- runPre accepted the run (set once); resume is true from here on.
  admitted_at timestamptz,
  -- runPost delivered; recovery re-delivers it for ended runs where this is null (at least once).
  post_hooks_at timestamptz,
  fingerprint text,
  version_started text not null,
  version_finished text,
  wall_ms integer,
  tokens_input bigint,
  tokens_output bigint,
  tokens_cache_read bigint,
  tokens_reasoning bigint,
  cost numeric,
  friction jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow, idempotency_key)
);

create index runs_claimable on {{schema}}.runs (created_at)
  where parent_id is null and status in ('pending', 'running');
create index runs_workflow_running on {{schema}}.runs (workflow)
  where parent_id is null and status = 'running';
create index runs_root on {{schema}}.runs (root_id);
create index runs_post_hooks_pending on {{schema}}.runs (finished_at)
  where post_hooks_at is null and status in ('done', 'failed', 'cancelled');

create table {{schema}}.steps (
  run_id text not null references {{schema}}.runs (id) on delete cascade,
  step_id text not null,
  kind text not null check (kind in ('code', 'effect', 'agent', 'workflow')),
  status text not null check (status in ('running', 'done', 'failed', 'cancelled')),
  handle jsonb,
  output jsonb,
  error text,
  error_kind text,
  attempts integer not null default 0,
  model text,
  tokens_input bigint not null default 0,
  tokens_output bigint not null default 0,
  tokens_cache_read bigint not null default 0,
  tokens_reasoning bigint not null default 0,
  cost numeric,
  tool_calls integer not null default 0,
  usage_by_model jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  argo_synced_at timestamptz,
  primary key (run_id, step_id)
);

create index steps_argo_outbox on {{schema}}.steps (finished_at)
  where kind = 'agent' and argo_synced_at is null and status in ('done', 'failed', 'cancelled');

-- Steer (and later signals) to a running step, delivered by the process holding the run's lease.
create table {{schema}}.signals (
  id bigserial primary key,
  run_id text not null references {{schema}}.runs (id) on delete cascade,
  step_id text not null,
  kind text not null check (kind in ('steer')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index signals_pending on {{schema}}.signals (run_id) where delivered_at is null;
