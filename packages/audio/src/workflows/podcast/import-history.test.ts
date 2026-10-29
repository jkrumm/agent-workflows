import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLegacyEpisodes } from '../../../../../scripts/import-podcast-history.ts'

// `scripts/import-podcast-history.ts` reads a legacy checkout read-only (a synthetic one here): done jobs only, the
// request without its private source, the transcript rendered from `script.json`. (bunfig's test root is `packages`.)

const dir = mkdtempSync(join(tmpdir(), 'podcast-import-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function legacyCheckout() {
  mkdirSync(join(dir, 'data', 'podcasts', 'job-done'), { recursive: true })
  const db = new Database(join(dir, 'data', 'podcasts.db'), { create: true })
  db.exec(`create table podcast_job (id text primary key, status text not null, created_at text not null,
    updated_at text not null, caller text not null, request_json text not null, state_json text not null)`)
  const insert = db.prepare('insert into podcast_job values (?, ?, ?, ?, ?, ?, ?)')
  const request = { source: 'PRIVATE NOTES', series: 'Show', minutes: 15, language: 'de' }
  const state = {
    title: 'Done one',
    description: 'Desc.',
    profile: { format: 'Gespräch' },
    brief: { format: 'Gespräch' },
  }
  insert.run('job-done', 'done', '2026-10-01T10:00:00.000Z', 'x', 'c', JSON.stringify(request), JSON.stringify(state))
  insert.run('job-failed', 'failed', '2026-10-02T10:00:00.000Z', 'x', 'c', JSON.stringify(request), '{}')
  insert.run('job-old', 'done', '2026-09-01T10:00:00.000Z', 'x', 'c', JSON.stringify({ source: 's' }), '{}')
  db.close()
  writeFileSync(
    join(dir, 'data', 'podcasts', 'job-done', 'script.json'),
    JSON.stringify({
      title: 'Done one',
      description: 'Desc.',
      segments: [{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }],
      hosts: [
        { id: 'A', name: 'Jonas' },
        { id: 'B', name: 'Lena' },
      ],
    }),
  )
}

describe('readLegacyEpisodes', () => {
  test('done jobs oldest first, source dropped, transcript rendered, defaults for pre-v2 rows', () => {
    legacyCheckout()
    const episodes = readLegacyEpisodes(dir)
    expect(episodes.map((e) => e.id)).toEqual(['job-old', 'job-done'])
    const done = episodes[1]
    expect(done).toMatchObject({
      series: 'Show',
      createdAt: '2026-10-01T10:00:00.000Z',
      title: 'Done one',
      profile: { format: 'Gespräch' },
      brief: { format: 'Gespräch' },
      request: { series: 'Show', minutes: 15, language: 'de' },
      transcript: '# Done one\n\nDesc.\n\n## S\n\n**Jonas:** Hallo.\n',
    })
    expect(JSON.stringify(episodes)).not.toContain('PRIVATE NOTES')
    expect(episodes[0]).toMatchObject({ series: 'Brain Sonderausgabe', profile: null, brief: null, transcript: null })
  })
})
