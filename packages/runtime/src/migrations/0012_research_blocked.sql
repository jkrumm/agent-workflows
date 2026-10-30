-- A fetch that a page turned away (a bot challenge, a 403) is kept with its URL and reason, so the run's output can hand
-- it over. Expand only: nullable, no reader of an older release depends on it.
alter table {{schema}}.research_tool_calls add column blocked jsonb;
