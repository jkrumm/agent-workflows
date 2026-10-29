-- The podcast's memory before the platform (audio `workflows/podcast/history.ts`): the episodes audio-gateway produced,
-- imported once by `scripts/import-podcast-history.ts`, so the editor and the `past_episodes` / `past_transcript` tools
-- see the show's whole past. Episodes the platform produces are not copied here: they are read from the journal
-- (finished `podcast` runs and their `script` step's script). Expand-only; nothing reads or writes this outside the podcast.
create table {{schema}}.podcast_episodes (
  -- The legacy job id.
  id text primary key,
  series text not null,
  -- When the legacy job was created: the history's order.
  created_at timestamptz not null,
  title text not null,
  description text not null default '',
  -- The legacy `EpisodeProfile` (format, lead, humor, opening, minutes, durationSeconds, topics, ...); null for episodes
  -- older than the profile.
  profile jsonb,
  -- The legacy `EpisodeBrief`; null when the job recorded none.
  brief jsonb,
  -- The request without its source: language, minutes, pinMinutes, research, publish, cover, brainNote, sourcePaths.
  request jsonb not null,
  -- The rendered markdown transcript (title, description, one heading per segment); null when no script was kept.
  transcript text,
  imported_at timestamptz not null default now()
);

create index podcast_episodes_series on {{schema}}.podcast_episodes (series, created_at desc);
