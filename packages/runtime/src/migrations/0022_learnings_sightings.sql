-- A learned fact is proposed again by a later retrospective when it keeps holding. The row keeps who saw it and when:
-- `sources` are the proposing run ids (empty for a human's add), `weeks` the ISO weeks of those sightings. Seen by two
-- independent runs in two different weeks, a proposed fact is activated; one not seen again for four weeks is retired.
alter table {{schema}}.learnings
  add column sources text[] not null default '{}',
  add column weeks text[] not null default '{}',
  add column last_seen_at timestamptz;

update {{schema}}.learnings
   set sources = case when source = 'manual' then '{}'::text[] else array[source] end,
       weeks = case when source = 'manual' then '{}'::text[]
                    else array[to_char(created_at at time zone 'UTC', 'IYYY"-W"IW')] end,
       last_seen_at = created_at;

alter table {{schema}}.learnings alter column last_seen_at set not null,
                                 alter column last_seen_at set default now();
