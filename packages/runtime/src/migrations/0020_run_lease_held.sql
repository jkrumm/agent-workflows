-- `lease_held` is true from the moment a process takes a run's lease until that process releases it cleanly (a
-- graceful shutdown, a finished drive, an infra-backoff exit). A takeover that finds it still true means the holder
-- died without releasing: only that takeover counts a drive toward the `crash_loop` cap. `runs_unfinished` serves the
-- sweep that ends runs of a workflow no process registers any more. Expand-only.
alter table {{schema}}.runs add column lease_held boolean not null default false;
create index runs_unfinished on {{schema}}.runs (updated_at) where status in ('pending', 'running');
