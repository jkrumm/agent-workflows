-- Scores (concept §6). `scores` holds the inline gate verdicts (`gates`, by step id) and the after-the-fact score of
-- the output (`final`); `score_source`, `scored_at` and `score_error` mirror `final` so drift and compare filter
-- without jsonb. `score_error` is set when the scorer could not score the run (its own failure, or a judge or journal
-- failure `score_attempts` times in a row): the run is not retried by drift until its workflow's scorer version
-- changes, and compare leaves it out. `drift_sample` is the run's persisted sample position: the first 32 bits of
-- md5(id), so a rate r samples exactly the runs below r × 2^32 and a drift tick reads an index range.
alter table {{schema}}.runs
  add column scores jsonb,
  add column score_source text check (score_source in ('regression', 'drift')),
  add column scored_at timestamptz,
  add column score_error text,
  add column score_attempts integer not null default 0,
  add column drift_sample bigint generated always as (('x' || lpad(substr(md5(id), 1, 8), 16, '0'))::bit(64)::bigint) stored;

-- Compare: an arm's runs by workflow, source and fingerprint prefix (a byte-order range, hence collate "C").
create index runs_scored on {{schema}}.runs (workflow, score_source, (fingerprint collate "C")) where scored_at is not null;
-- Drift: unscored, done, top-level runs by sample position; a scored run leaves the index.
create index runs_drift on {{schema}}.runs (workflow, drift_sample, finished_at)
  where status = 'done' and parent_id is null and scored_at is null;
-- Drift: runs whose scorer failed, re-scored once their workflow's scorer version changes.
create index runs_score_error on {{schema}}.runs (workflow) where score_error is not null;
