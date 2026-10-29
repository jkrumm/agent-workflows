#!/usr/bin/env bun
// One-time import of audio-gateway's podcast episodes into the platform's `podcast_episodes` table (runtime migration
// 0010), so the `podcast` workflow's editor and its `past_episodes` / `past_transcript` tools see the show's past.
//   bun scripts/import-podcast-history.ts            dry run: prints what would be imported, writes nothing
//   bun scripts/import-podcast-history.ts --commit   migrates the journal schema (as any process boot does), upserts
// Reads the legacy ledger (`data/podcasts.db`) and `data/podcasts/<id>/` READ-ONLY (AGW_LEGACY_AUDIO, default
// ~/SourceRoot/audio-gateway). Writes to AGW_PG_URL, schema AGW_PG_SCHEMA (default `agw`); on the mini run it through
// `secrets-run` like the host. Re-running is idempotent (upsert by legacy job id). Only `done` jobs are imported: the
// history is finished episodes. Prints ids and counts only, never episode text.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderTranscriptMarkdown, type TranscriptScript } from '../packages/audio/src/workflows/podcast/history.ts'
import { migrate } from '../packages/runtime/src/migrate.ts'

export interface LegacyEpisode {
  id: string
  series: string
  createdAt: string
  title: string
  description: string
  profile: unknown
  brief: unknown
  request: Record<string, unknown>
  transcript: string | null
}

const DEFAULT_SERIES = 'Brain Sonderausgabe'

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

/** The done episodes of a legacy checkout, oldest first. The request keeps every field but the private source text. */
export function readLegacyEpisodes(legacyDir: string): LegacyEpisode[] {
  const db = new Database(join(legacyDir, 'data', 'podcasts.db'), { readonly: true })
  try {
    const rows = db
      .query<{ id: string; created_at: string; request_json: string; state_json: string }, []>(
        "select id, created_at, request_json, state_json from podcast_job where status = 'done' order by created_at",
      )
      .all()
    return rows.map((row) => {
      const { source: _source, ...request } = JSON.parse(row.request_json) as Record<string, unknown>
      const state = JSON.parse(row.state_json) as {
        title?: string | null
        description?: string | null
        profile?: unknown
        brief?: unknown
      }
      const dir = join(legacyDir, 'data', 'podcasts', row.id)
      const script = readJson<TranscriptScript>(join(dir, 'script.json'))
      return {
        id: row.id,
        series: typeof request.series === 'string' && request.series.trim() ? request.series : DEFAULT_SERIES,
        createdAt: row.created_at,
        title: state.title ?? script?.title ?? '',
        description: state.description ?? script?.description ?? '',
        profile: state.profile ?? null,
        brief: state.brief ?? readJson(join(dir, 'brief.json')),
        request,
        transcript: script ? renderTranscriptMarkdown(script) : null,
      }
    })
  } finally {
    db.close()
  }
}

/** Minimal `pg` surface, resolved from the runtime package (scripts/ has no dependencies of its own). */
interface Pool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

async function main() {
  const commit = process.argv.includes('--commit')
  const legacyDir = process.env.AGW_LEGACY_AUDIO ?? join(homedir(), 'SourceRoot', 'audio-gateway')
  const episodes = readLegacyEpisodes(legacyDir)
  for (const e of episodes) {
    console.log(
      `${e.id.slice(0, 8)}  ${e.createdAt.slice(0, 10)}  profile:${e.profile ? 'y' : 'n'} brief:${e.brief ? 'y' : 'n'} transcript:${e.transcript ? 'y' : 'n'}`,
    )
  }
  console.log(`${episodes.length} done episode(s) in the legacy ledger`)
  if (!commit) {
    console.log('dry run: nothing written (pass --commit to import)')
    return
  }
  const url = process.env.AGW_PG_URL
  if (!url) throw new Error('AGW_PG_URL is not set')
  const schema = process.env.AGW_PG_SCHEMA?.trim() || 'agw'
  const require = createRequire(resolve(import.meta.dir, '../packages/runtime/package.json'))
  const { Pool } = require('pg') as { Pool: new (options: { connectionString: string; max: number }) => Pool }
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    await migrate(pool as never, schema)
    for (const e of episodes) {
      await pool.query(
        `insert into "${schema}".podcast_episodes
           (id, series, created_at, title, description, profile, brief, request, transcript)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set series = excluded.series, created_at = excluded.created_at,
           title = excluded.title, description = excluded.description, profile = excluded.profile,
           brief = excluded.brief, request = excluded.request, transcript = excluded.transcript,
           imported_at = now()`,
        [
          e.id,
          e.series,
          e.createdAt,
          e.title,
          e.description,
          e.profile === null ? null : JSON.stringify(e.profile),
          e.brief === null ? null : JSON.stringify(e.brief),
          JSON.stringify(e.request),
          e.transcript,
        ],
      )
    }
    const { rows } = await pool.query(`select count(*)::int as n from "${schema}".podcast_episodes`)
    console.log(`imported ${episodes.length}; podcast_episodes now holds ${String(rows[0]?.n)}`)
  } finally {
    await pool.end()
  }
}

if (import.meta.main) await main()
