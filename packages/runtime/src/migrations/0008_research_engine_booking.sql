-- An engine job's cost is booked on the research run once per step, decided by the ledger itself: the row that books
-- it carries the booking call's token in `booked_by`, and the partial unique index lets only one row per run, step and
-- job hold one. A retried write that finds its own token knows it booked (its first write was acknowledged late).
alter table {{schema}}.research_tool_calls add column booked_by text;

create unique index research_tool_calls_booking on {{schema}}.research_tool_calls (run_id, step_id, engine_job)
  where booked_by is not null;
