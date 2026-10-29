// A door token is a door credential only: the audio process serves the door and the whole host API on one port, and
// a token the deploy did not list in AGW_API_CALLERS must not open the API.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshSchema, inspector, PG_URL, until } from '../../runtime/test/support/pg.ts'
import { bootAudio, type DoorHandlers, loadAudioProcessConfig } from '../src/process/index.ts'
import { testConfig } from '../src/testing/index.ts'

const SECRET = 'test-secret-0123456789abcdef-0123456789'
const ARGO = 'argo-token-0123456789abcdef-0123456789a'
const db = freshSchema('audioiso')
const sql = inspector(db.schema)
const stateDir = mkdtempSync(join(tmpdir(), 'agw-audio-iso-'))

afterAll(async () => {
  await sql.close()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
})

const handlers: DoorHandlers = {
  speech: () => async () => Response.json({ ok: true }),
  transcriptions: () => async () => Response.json({ text: 'hallo' }),
}

describe('door tokens are not API credentials', () => {
  test('the door accepts the token and records its caller; every other path answers 401', async () => {
    const running = await bootAudio({
      audio: { config: testConfig('https://iu.example.com/anthropic'), env: {} },
      config: loadAudioProcessConfig({
        HOME: tmpdir(),
        AGW_API_SECRET: SECRET,
        AGW_MACHINE: 'test-machine',
        AGW_PG_URL: PG_URL,
        AGW_PG_SCHEMA: db.schema,
        AGW_AUDIO_PORT: '0',
        AGW_AUDIO_STATE_DIR: stateDir,
        AGW_VERSION: 'test-sha',
      }),
      handlers,
      tokens: new Map([['argo', ARGO]]),
    })
    const url = `http://127.0.0.1:${running.port}`
    const bearer = { authorization: `Bearer ${ARGO}` }
    try {
      const door = await fetch(`${url}/v1/audio/speech`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ model: 'tts-1', input: 'Hallo', voice: 'Charon' }),
      })
      expect(door.status).toBe(200)
      const runId = door.headers.get('agw-run-id') as string
      const row = await until(async () => {
        const found = await sql.run(runId)
        return found?.status === 'done' ? found : undefined
      }, 'the door run')
      expect(row).toMatchObject({ caller: 'argo', project: null })

      const attempts: [string, RequestInit][] = [
        ['/workflows/audio/ping', { method: 'POST', headers: { ...bearer, prefer: 'wait=5' } }],
        [`/runs/${runId}`, { headers: bearer }],
        ['/openapi.json', { headers: bearer }],
      ]
      for (const [path, init] of attempts) {
        const response = await fetch(`${url}${path}`, init)
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
      }
      // Nothing was started by the refused ping.
      const { rows } = await sql.pool.query(
        `select count(*)::int as n from "${db.schema}".runs where workflow = 'audio.ping'`,
      )
      expect(rows[0].n).toBe(0)
      // The API secret still opens it.
      expect((await fetch(`${url}/openapi.json`, { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(200)
    } finally {
      await running.shutdown()
    }
  })
})
