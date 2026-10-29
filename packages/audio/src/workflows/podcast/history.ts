import type { HistoryPort } from './ports.ts'
import type { HostValue } from './schema.ts'
import type { EpisodeProfile, EpisodeSummary } from './types.ts'

// The show's memory on Postgres. Two sources, one order: finished `podcast` runs of purpose `prod` (title, description
// and profile from the run's output, the transcript from its `script` step) and the legacy episodes imported into
// `podcast_episodes` (migration 0010). A run's id and a legacy job id never collide (both random, different shapes).

/** The one call this adapter needs from a Postgres pool (`pg`'s `Pool.query` fits). */
export interface Queryable {
  query<R extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export const WORKFLOW_ID = 'podcast'

/** The persisted script a transcript renders from: legacy `PersistedPodcastScript`. */
export interface TranscriptScript {
  title: string
  description: string
  segments: { title: string; turns: { speaker: 'A' | 'B'; text: string }[] }[]
  hosts: Pick<HostValue, 'id' | 'name'>[]
}

/** Title, description, then one `##` heading and `**Name:** text` lines per segment (legacy, byte for byte). */
export function renderTranscriptMarkdown(script: TranscriptScript): string {
  const nameById = new Map<string, string>(script.hosts.map((h) => [h.id, h.name] as const))
  const lines: string[] = [`# ${script.title}`, '', script.description, '']
  for (const segment of script.segments) {
    lines.push(`## ${segment.title}`, '')
    for (const turn of segment.turns) lines.push(`**${nameById.get(turn.speaker) ?? turn.speaker}:** ${turn.text}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

type Row = { id: string; created_at: Date | string; title: string | null; description: string | null; profile: unknown }

export function postgresHistory(db: Queryable, schema: string): HistoryPort {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
  const s = `"${schema}"`
  return {
    async recent(series, limit) {
      const { rows } = await db.query<Row>(
        `select id, created_at, title, description, profile from (
           select r.id, r.created_at, r.output->>'title' as title, r.output->>'description' as description,
                  r.output->'profile' as profile
             from ${s}.runs r
            where r.workflow = $1 and r.status = 'done' and r.parent_id is null and r.purpose = 'prod'
              and r.input->>'series' = $2
           union all
           select e.id, e.created_at, e.title, e.description, e.profile
             from ${s}.podcast_episodes e
            where e.series = $2
         ) episodes
         order by created_at desc
         limit $3`,
        [WORKFLOW_ID, series, limit],
      )
      return rows.map(
        (row): EpisodeSummary => ({
          id: row.id,
          createdAt: new Date(row.created_at).toISOString(),
          title: row.title ?? '',
          description: row.description ?? '',
          profile: (row.profile as EpisodeProfile | null) ?? null,
        }),
      )
    },
    async transcript(id) {
      const imported = await db.query<{ transcript: string | null }>(
        `select transcript from ${s}.podcast_episodes where id = $1`,
        [id],
      )
      if (imported.rows[0]) return imported.rows[0].transcript
      const { rows } = await db.query<{ output: TranscriptScript | null }>(
        `select st.output->'script' as output from ${s}.steps st join ${s}.runs r on r.id = st.run_id
          where st.run_id = $1 and st.step_id = 'script' and st.status = 'done'
            and r.workflow = $2 and r.status = 'done'`,
        [id, WORKFLOW_ID],
      )
      const script = rows[0]?.output
      return script ? renderTranscriptMarkdown(script) : null
    },
  }
}
