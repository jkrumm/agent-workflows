-- Scores (concept §6). `scores` holds the inline gate verdicts (`gates`, by step id) and the after-the-fact score of
-- the output (`final`); `score_source` and `scored_at` mirror `final` so drift and compare filter without jsonb.
alter table {{schema}}.runs
  add column scores jsonb,
  add column score_source text check (score_source in ('regression', 'drift')),
  add column scored_at timestamptz;

-- Compare reads regression runs per workflow; the Argo outbox re-posts steps of runs scored after their sync.
create index runs_scored on {{schema}}.runs (workflow, scored_at) where scored_at is not null;
