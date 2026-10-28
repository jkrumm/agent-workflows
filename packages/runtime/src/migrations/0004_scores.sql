-- Scores (concept §6). `scores` holds the inline gate verdicts (`gates`, by step id) and the after-the-fact score of
-- the output (`final`); `score_source` and `scored_at` mirror `final` so drift and compare filter without jsonb.
-- `drift_sample` is the run's persisted sample position: the first 32 bits of md5(id), so a rate r samples exactly
-- the runs below r × 2^32, and a drift tick reads an index range instead of rescanning the unsampled runs.
alter table {{schema}}.runs
  add column scores jsonb,
  add column score_source text check (score_source in ('regression', 'drift')),
  add column scored_at timestamptz,
  add column drift_sample bigint generated always as (('x' || lpad(substr(md5(id), 1, 8), 16, '0'))::bit(64)::bigint) stored;

-- Compare reads regression runs per workflow; the Argo outbox re-posts steps of runs scored after their sync.
create index runs_scored on {{schema}}.runs (workflow, score_source, fingerprint) where scored_at is not null;
-- Drift: unscored, done, top-level runs by sample position; a scored run leaves the index.
create index runs_drift on {{schema}}.runs (workflow, drift_sample, finished_at)
  where status = 'done' and parent_id is null and scored_at is null;
