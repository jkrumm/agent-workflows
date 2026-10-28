-- Which IU key paid for a run: a label (usage-tracker contract), stamped by the host that admits the run. Rows
-- stored before this column read as `personal`. Never key material.
alter table {{schema}}.runs add column iu_key text not null default 'personal';
