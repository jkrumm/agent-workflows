-- A run's post hooks are marked delivered (`post_hooks_at`) either when they ran or when `maxPostHookAttempts` failed
-- and the runtime gave up. Readers of the run record need to tell the two apart: this is set only by the give-up.
-- Nullable and unset on every older row, which is right: an older row's hooks were delivered.
alter table {{schema}}.runs add column post_hooks_failed_at timestamptz;
