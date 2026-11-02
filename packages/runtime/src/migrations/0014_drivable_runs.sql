-- A run is drivable on its own (claimed by recovery, leased, holding a concurrency slot, drift-sampled) when it is
-- the root of its own lease tree: `id = root_id`, no longer `parent_id is null`. An eval case run is the first run
-- with a parent that is still its own root (`parent_id` = the eval run, so the eval run's cost rolls its cases up;
-- `root_id` = itself, so it keeps its own lease and is redelivered to the process that serves its workflow). For
-- every row written before this migration the two predicates are equivalent: a top-level run had `parent_id is null`
-- and `root_id = id`, a fan-out child a parent and its root's id. The partial indexes are re-keyed to match.
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
