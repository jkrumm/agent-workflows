-- Who started a run and for which project (Argo attributes spend per caller): stamped at admission by the host door
-- from the credential and the caller headers, inherited by child runs. Expand only: nullable, no reader depends on
-- them, so a rollback release runs unchanged. A null caller is a run the host itself started (no door admitted it).
alter table {{schema}}.runs add column caller text, add column project text, add column workspace text;
