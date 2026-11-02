-- A run tree's experiment arm (`agw eval run --arm <file>`): route patches and workflow params, set on the eval run
-- from its input and copied to every descendant run (case replays, their fan-out children, judge calls), so every
-- route resolution inside the tree applies it and the run fingerprint includes it. Null for every run without one:
-- production resolves the plain table. Expand only: nullable, no backfill. A rollback release ignores the column, so an
-- armed eval run it resumes would run on the plain table under the armed fingerprint: drain armed eval runs (let them
-- finish or `agw run cancel` them) before rolling back past this migration.
alter table {{schema}}.runs add column arm jsonb;
