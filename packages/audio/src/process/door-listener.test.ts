// The door-only listener (AGW_AUDIO_DOOR_PORT): booted for real beside the main one. It answers the door's routes and a
// bodyless 404 for everything else, so a forwarded port reaches the door and never the API or `/health`.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunningHost } from '@agent-workflows/host'
import { freshSchema, PG_URL } from '../../../runtime/test/support/pg.ts'
import { testConfig } from '../testing/index.ts'
import { AUDIO_DOOR_PORT, bootAudio, type DoorHandlers, loadAudioProcessConfig } from './index.ts'

const AUDIO = { config: testConfig('https://iu.example.com/anthropic'), env: {} }
const SECRET = 'test-secret-0123456789abcdef-0123456789'
const HERMES = 'hermes-token-0123456789abcdef-0123456789'
const db = freshSchema('audiodoor')
const stateDir = mkdtempSync(join(tmpdir(), 'agw-audio-door-state-'))

afterAll(async () => {
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}) => ({
  HOME: tmpdir(),
  AGW_API_SECRET: SECRET,
  AGW_MACHINE: 'test-machine',
  AGW_PG_URL: PG_URL,
  AGW_PG_SCHEMA: db.schema,
  AGW_AUDIO_PORT: '0',
  AGW_AUDIO_STATE_DIR: stateDir,
  AGW_VERSION: 'test-sha',
  ...extra,
})

/** A fake lane: speech answers 200 with two bytes, transcriptions with text. */
const handlers: DoorHandlers = {
  speech: () => async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/pcm' } }),
  transcriptions: () => async () => Response.json({ text: 'hallo' }),
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function start(extra: Record<string, string> = {}): Promise<RunningHost> {
  return bootAudio({
    audio: AUDIO,
    config: loadAudioProcessConfig(env(extra)),
    handlers,
    tokens: new Map([['hermes', HERMES]]),
  })
}

const refused = async (url: string) => {
  try {
    await fetch(url)
    return false
  } catch {
    return true
  }
}

describe('the door-only listener', () => {
  test('answers the door and a bodyless 404 for everything else', async () => {
    const audio = await start()
    const [doorPort] = audio.doorOnlyPorts
    const door = `http://127.0.0.1:${doorPort}`
    try {
      expect(doorPort).not.toBe(audio.port)
      for (const path of ['/health', '/openapi.json', '/workflows/audio/ping', '/runs/x', '/']) {
        const bare = await fetch(`${door}${path}`)
        expect(bare.status).toBe(404)
        expect(await bare.text()).toBe('')
        // The valid API secret opens nothing here.
        const authed = await fetch(`${door}${path}`, { method: 'POST', headers: bearer(SECRET) })
        expect(authed.status).toBe(404)
        expect(await authed.text()).toBe('')
      }
      for (const path of ['/v1/audio/speech', '/audio/speech', '/v1/audio/transcriptions']) {
        for (const method of ['GET', 'PUT', 'DELETE']) {
          const wrong = await fetch(`${door}${path}`, { method, headers: bearer(HERMES) })
          expect(wrong.status).toBe(404)
          expect(await wrong.text()).toBe('')
        }
      }
      // The main listener still serves all of it.
      expect((await fetch(`http://127.0.0.1:${audio.port}/health`)).status).toBe(200)
    } finally {
      await audio.shutdown()
    }
  })

  test('a POST to the door path behaves as on the main listener: 401 without a token, the lane with one', async () => {
    const audio = await start()
    const [doorPort] = audio.doorOnlyPorts
    const body = JSON.stringify({ model: 'tts-1', input: 'Hallo', voice: 'Charon', response_format: 'pcm' })
    try {
      for (const port of [doorPort, audio.port]) {
        const base = `http://127.0.0.1:${port}`
        const none = await fetch(`${base}/v1/audio/speech`, { method: 'POST', body })
        expect(none.status).toBe(401)
        expect(await none.json()).toEqual({ error: { message: 'unauthorized', type: 'invalid_request_error' } })
        const wrong = await fetch(`${base}/v1/audio/speech`, {
          method: 'POST',
          body,
          headers: bearer(`${HERMES}x`),
        })
        expect(wrong.status).toBe(401)
        const ok = await fetch(`${base}/audio/speech`, { method: 'POST', body, headers: bearer(HERMES) })
        expect(ok.status).toBe(200)
        expect(ok.headers.get('content-type')).toBe('audio/pcm')
        expect(ok.headers.get('agw-run-id')).toBeTruthy()
        expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2])
        const text = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body, headers: bearer(HERMES) })
        expect(text.status).toBe(200)
        expect(await text.json()).toEqual({ text: 'hallo' })
      }
    } finally {
      await audio.shutdown()
    }
  })

  test('stopping drains both listeners', async () => {
    const audio = await start()
    const urls = [audio.port, ...audio.doorOnlyPorts].map((port) => `http://127.0.0.1:${port}/health`)
    expect((await fetch(urls[0] as string)).status).toBe(200)
    expect((await fetch(urls[1] as string)).status).toBe(404)
    await audio.shutdown()
    for (const url of urls) expect(await refused(url)).toBe(true)
  })

  test('a taken door port fails the start and leaves the main port free', async () => {
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('taken') })
    const main = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
    const mainPort = main.port as number
    await main.stop(true) // a free port number to hand the process as its main port
    try {
      const failed = await start({
        AGW_AUDIO_PORT: String(mainPort),
        AGW_AUDIO_DOOR_PORT: String(squatter.port),
      }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(failed).toMatch(/port|EADDRINUSE|in use/i)
      // The half-started process released the main port.
      const again = Bun.serve({ hostname: '127.0.0.1', port: mainPort, fetch: () => new Response('free') })
      await again.stop(true)
    } finally {
      await squatter.stop(true)
    }
  })
})

describe('the door port setting', () => {
  test('defaults to 7793 on a fixed main port and follows an ephemeral one', () => {
    expect(loadAudioProcessConfig(env({ AGW_AUDIO_PORT: '7792' })).doorPort).toBe(AUDIO_DOOR_PORT)
    expect(AUDIO_DOOR_PORT).toBe(7793)
    expect(loadAudioProcessConfig(env()).doorPort).toBe(0)
    expect(loadAudioProcessConfig(env({ AGW_AUDIO_DOOR_PORT: '7801' })).doorPort).toBe(7801)
  })

  test('is validated like the main port, and never the main port', () => {
    const message = (extra: Record<string, string>) => {
      try {
        loadAudioProcessConfig(env(extra))
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    for (const bad of ['abc', '1.5', '-1', '65536'])
      expect(message({ AGW_AUDIO_DOOR_PORT: bad })).toContain('AGW_AUDIO_DOOR_PORT must be an integer from 0 to 65535')
    expect(message({ AGW_AUDIO_PORT: '7792', AGW_AUDIO_DOOR_PORT: '7792' })).toContain(
      'AGW_AUDIO_DOOR_PORT must differ from AGW_AUDIO_PORT',
    )
  })
})
