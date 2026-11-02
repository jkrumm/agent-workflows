-- The route id a step's model calls were resolved from, so reports group by route and model: the one route named by the
-- reports that name one, null when they name several or none. Expand only: nullable, no reader depends on it, so a rollback release runs
-- unchanged. Rows written before this migration stay null (no backfill).
alter table {{schema}}.steps add column route text;
