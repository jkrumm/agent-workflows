-- The research engine arm is gone (Wave 6, concept P3): the tool gate no longer runs engine jobs, so the columns that
-- kept one job's id, its reported cost and its booking claim (0007, 0008) go with the index that let one row per run,
-- step and job hold the booking. Rows of the web tools are unchanged.
drop index {{schema}}.research_tool_calls_booking;

alter table {{schema}}.research_tool_calls
  drop column booked_by,
  drop column engine_cost,
  drop column engine_job;
