-- A run is drivable on its own (claimed by recovery, leased, holding a concurrency slot, drift-sampled) when it is
-- the root of its own lease tree: `id = root_id`, no longer `parent_id is null`. An eval case run is the first run
-- with a parent that is still its own root (`parent_id` = the eval run, so the eval run's cost rolls its cases up;
-- `root_id` = itself, so it keeps its own lease and is redelivered to the process that serves its workflow). For
-- every row written before this migration the two predicates are equivalent: a top-level run had `parent_id is null`
-- and `root_id = id`, a fan-out child a parent and its root's id. The partial indexes are re-keyed to match.
--
-- Cutover. `runs.cost` written before this release is the run's own steps only; from this release on the run record
-- sums the steps of the run and all its descendants, so a parent's cost covers its tree. Rows recorded before are not
-- recomputed: a sum across the deploy mixes the two meanings. A rollback to a release before this one keeps
-- `parent_id is null` as its claim predicate: it never claims a parented case run (pending or orphaned), which waits
-- for a redeploy of this release or a later one; its queries also no longer match these partial indexes (correct,
-- only slower).
drop index {{schema}}.runs_claimable;
create index runs_claimable on {{schema}}.runs (created_at)
  where id = root_id and status in ('pending', 'running');

drop index {{schema}}.runs_workflow_running;
create index runs_workflow_running on {{schema}}.runs (workflow)
  where id = root_id and status = 'running';

drop index {{schema}}.runs_drift;
create index runs_drift on {{schema}}.runs (workflow, drift_sample, finished_at)
  where status = 'done' and id = root_id and scored_at is null;

-- A run's record adds its direct children's (`recordMiddleware`), read by `parent_id` at every `runPost`.
create index runs_parent on {{schema}}.runs (parent_id) where parent_id is not null;
