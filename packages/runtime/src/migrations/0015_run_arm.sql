-- A run tree's experiment arm (`agw eval run --arm <file>`): route patches and workflow params, set on the eval run
-- from its input and copied to every descendant run (case replays, their fan-out children, judge calls), so every
-- route resolution inside the tree applies it and the run fingerprint includes it. Null for every run without one:
-- production resolves the plain table. Expand only: nullable, no backfill; a rollback release ignores the column.
alter table {{schema}}.runs add column arm jsonb;
