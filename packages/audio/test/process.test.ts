// The audio process booted for real (Postgres, HTTP on port 0) with stub door handlers of the lanes' interface
// (`createSpeechHandler(deps)`, `createTranscriptionsHandler(deps)`): the process core, the ping workflow, the door's
// auth and its one run per request.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineWorkflowModule, type RunningHost } from '@agent-workflows/host'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { freshSchema, inspector, PG_URL, until } from '../../runtime/test/support/pg.ts'
import { audioRoutes, createSpeechHandler, createTranscriptionsHandler } from '../src/index.ts'
import {
  audioEvent,
  fakeMedia,
  instantClock,
  silentLog,
  startFakeIu,
  streamBody,
  testConfig,
} from '../src/testing/index.ts'
import {
  type AudioWorkflowDeps,
  bootAudio,
  DOOR_WORKFLOW_IDS,
  type DoorEvent,
  type DoorHandlerDeps,
  type DoorHandlers,
  loadAudioProcessConfig,
} from '../src/process/index.ts'

const SECRET = 'test-secret-0123456789abcdef-0123456789'
const HERMES = 'hermes-token-0123456789abcdef-0123456789'
const db = freshSchema('audio')
const sql = inspector(db.schema)
const stateDir = mkdtempSync(join(tmpdir(), 'agw-audio-state-'))

afterAll(async () => {
  await sql.close()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
})

const config = () =>
  loadAudioProcessConfig({
    HOME: tmpdir(),
    AGW_API_SECRET: SECRET,
    AGW_MACHINE: 'test-machine',
    AGW_PG_URL: PG_URL,
    AGW_PG_SCHEMA: db.schema,
    AGW_AUDIO_PORT: '0',
    AGW_AUDIO_STATE_DIR: stateDir,
    AGW_VERSION: 'test-sha',
  })

const call = (deps: DoorHandlerDeps, req: Request, extra: Partial<DoorEvent> = {}): DoorEvent => ({
  kind: 'call',
  requestId: deps.requestId(req),
  caller: req.headers.get('x-audio-source') ?? deps.caller(req) ?? 'unknown',
  routeId: 'tts.gemini',
  model: 'gemini-tts',
  status: 200,
  costUsd: 0.002,
  costSource: 'rate',
  inputTokens: 100,
  outputTokens: 400,
  ...extra,
})

/** Lanes-shaped stubs: speech streams two chunks and records two calls (one failed attempt) and a summary at body end. */
function stubHandlers(hold?: Promise<void>): DoorHandlers & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    speech: (deps) => async (req) => {
      const json = (await req.json().catch(() => null)) as { input?: string } | null
      seen.push(deps.caller(req) ?? 'none')
      if (!json?.input)
        return Response.json(
          { error: { message: 'input is required', type: 'invalid_request_error' } },
          { status: 400 },
        )
      await hold
      deps.usage.record(
        call(deps, req, { status: 503, costUsd: 0, costSource: 'not-billed', inputTokens: 0, outputTokens: 0 }),
      )
      deps.usage.record(call(deps, req))
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift()
          if (next) return controller.enqueue(next)
          deps.usage.record({ ...call(deps, req), kind: 'request', requestedModel: 'tts-1' })
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'audio/pcm' } })
    },
    transcriptions: () => async () => Response.json({ text: 'hallo' }),
  }
}

async function start(handlers: DoorHandlers): Promise<RunningHost & { url: string }> {
  const running = await bootAudio({ config: config(), handlers, tokens: new Map([['hermes', HERMES]]) })
  return { ...running, url: `http://127.0.0.1:${running.port}` }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('the audio process', () => {
  test('health, a contract of its own workflows only, and agw audio ping recorded end to end', async () => {
    const audio = await start(stubHandlers())
    try {
      const health = await (await fetch(`${audio.url}/health`)).json()
      expect(health).toEqual({ status: 'ok', version: 'test-sha' })

      const doc = (await (await fetch(`${audio.url}/openapi.json`, { headers: bearer(SECRET) })).json()) as {
        paths: Record<string, Record<string, { operationId: string; 'x-cli'?: { command: string[] } }>>
      }
      const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods))
      const commands = ops.map((op) => op['x-cli']?.command.join(' ')).sort()
      // No capability (the host serves them; two processes declaring one is a CLI conflict), no door route.
      expect(commands.filter((c) => !c?.startsWith('run '))).toEqual(['audio ping'])

      expect((await fetch(`${audio.url}/openapi.json`)).status).toBe(401)
      const res = await fetch(`${audio.url}/workflows/audio/ping`, {
        method: 'POST',
        headers: { ...bearer(SECRET), prefer: 'wait=20', 'x-agw-purpose': 'verify' },
      })
      const state = (await res.json()) as { runId: string; status: string; output: unknown }
      expect(state.status).toBe('done')
      expect(state.output).toEqual({ process: 'audio', pong: true })
      const row = await sql.run(state.runId)
      expect(row?.purpose).toBe('verify')
    } finally {
      await audio.shutdown()
    }
  })

  test('the door: 401 without a caller token, the legacy 400 on a bad body, one run per request with its cost', async () => {
    const handlers = stubHandlers()
    const audio = await start(handlers)
    try {
      const body = JSON.stringify({ model: 'tts-1', input: 'Hallo', voice: 'Charon', response_format: 'pcm' })
      const refused = await fetch(`${audio.url}/v1/audio/speech`, { method: 'POST', body })
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual({ error: { message: 'unauthorized', type: 'invalid_request_error' } })
      expect(refused.headers.get('www-authenticate')).toBe('Bearer')
      const wrong = await fetch(`${audio.url}/v1/audio/speech`, { method: 'POST', body, headers: bearer(`${HERMES}x`) })
      expect(wrong.status).toBe(401)
      expect(handlers.seen).toEqual([])

      const bad = await fetch(`${audio.url}/v1/audio/speech`, { method: 'POST', body: '{}', headers: bearer(SECRET) })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: { type: string } }).error.type).toBe('invalid_request_error')
      const badRun = bad.headers.get('agw-run-id')
      expect(badRun).toBeTruthy()

      // The suffix form legacy accepted (`/audio/speech` without `/v1`) and a Hermes token.
      const ok = await fetch(`${audio.url}/audio/speech`, { method: 'POST', body, headers: bearer(HERMES) })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('audio/pcm')
      const runId = ok.headers.get('agw-run-id')
      expect(runId).toBeTruthy()
      expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2, 3])

      const done = await until(async () => {
        const row = await sql.run(runId as string)
        return row?.status === 'done' ? row : undefined
      }, 'the door run')
      expect(done.workflow).toBe(DOOR_WORKFLOW_IDS.speech)
      expect(done.purpose).toBe('prod')
      expect(done.input).toMatchObject({ caller: 'hermes', source: null, path: '/audio/speech' })
      expect(done.output).toEqual({
        status: 200,
        route: 'tts.gemini',
        model: 'gemini-tts',
        requestedModel: 'tts-1',
        costUsd: 0.002,
        calls: 2,
        complete: true,
      })
      const step = await sql.step(runId as string, 'request')
      expect(Number(step?.cost)).toBeCloseTo(0.002, 6)
      expect(Number(step?.tokens_input)).toBe(100)

      const badDone = await until(async () => {
        const row = await sql.run(badRun as string)
        return row?.status === 'done' ? row : undefined
      }, 'the bad-body run')
      expect(badDone.input).toMatchObject({ caller: PLATFORM })
      expect(badDone.output).toMatchObject({ calls: 0, complete: false, costUsd: null })
    } finally {
      await audio.shutdown()
    }
  })

  test("a module's deps carry the journal (pool and schema), which the podcast room reads", async () => {
    let seen: AudioWorkflowDeps['journal'] | undefined
    const probe = defineWorkflowModule({
      id: 'probe',
      create(deps) {
        seen = (deps as AudioWorkflowDeps).journal
        const workflow = defineWorkflow({
          id: 'audio.probe',
          version: 'v1',
          input: z.object({}),
          output: z.object({ n: z.number() }),
          run: async (ctx) =>
            ctx.step('read', async () => {
              const { rows } = await (seen as AudioWorkflowDeps['journal']).db.query(
                `select count(*)::int as n from "${db.schema}".runs`,
              )
              return { n: (rows[0] as { n: number }).n }
            }),
        })
        return [{ workflow }]
      },
    })
    const running = await bootAudio({
      config: config(),
      handlers: stubHandlers(),
      tokens: new Map(),
      modules: [{ ...probe, file: 'probe/module.ts' }],
    })
    try {
      expect(seen?.schema).toBe(db.schema)
      const res = await fetch(`http://127.0.0.1:${running.port}/workflows/audio/probe`, {
        method: 'POST',
        headers: { ...bearer(SECRET), prefer: 'wait=20' },
      })
      const state = (await res.json()) as { status: string; output: { n: number } }
      expect(state.status).toBe('done')
      expect(state.output.n).toBeGreaterThan(0)
    } finally {
      await running.shutdown()
    }
  })

  test("the lanes' real door handlers, mounted: a pcm stream and a bad body, each one recorded run", async () => {
    const iu = startFakeIu({
      geminiStream: () => streamBody(audioEvent(new Uint8Array(4800)), audioEvent(new Uint8Array(4800))),
    })
    const lanes = {
      config: testConfig(iu.baseUrl),
      fetch: iu.fetch,
      media: fakeMedia,
      clock: instantClock,
      log: silentLog,
    }
    const audio = await start({
      speech: (deps) => createSpeechHandler({ ...lanes, ...deps }),
      transcriptions: (deps) => createTranscriptionsHandler({ ...lanes, ...deps }),
    })
    try {
      const pcm = await fetch(`${audio.url}/v1/audio/speech`, {
        method: 'POST',
        headers: { ...bearer(HERMES), 'content-type': 'application/json' },
        body: JSON.stringify({ model: LITE, input: 'Hallo.', voice: 'Charon', response_format: 'pcm' }),
      })
      expect(pcm.status).toBe(200)
      const pcmRun = pcm.headers.get('agw-run-id') as string
      expect((await pcm.arrayBuffer()).byteLength).toBe(9600)
      const bad = await fetch(`${audio.url}/v1/audio/speech`, {
        method: 'POST',
        body: 'model=x',
        headers: bearer(SECRET),
      })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({
        error: { message: 'request body must be valid JSON', type: 'invalid_request_error' },
      })
      const badRun = bad.headers.get('agw-run-id') as string

      const done = (id: string) =>
        until(async () => {
          const row = await sql.run(id)
          return row?.status === 'done' ? row : undefined
        }, `run ${id}`)
      const pcmRow = await done(pcmRun)
      expect(pcmRow.input).toMatchObject({ caller: 'hermes' })
      expect(pcmRow.output).toMatchObject({ status: 200, complete: true })
      expect((pcmRow.output as { calls: number }).calls).toBeGreaterThan(0)
      expect((await done(badRun)).output).toMatchObject({ calls: 0 })
    } finally {
      await audio.shutdown()
      iu.stop()
    }
  })

  test('a recording failure never fails the request: it is answered, and no run exists under its id', async () => {
    const audio = await start(stubHandlers())
    try {
      const res = await fetch(`${audio.url}/v1/audio/transcriptions`, {
        method: 'POST',
        body: new FormData(),
        headers: { ...bearer(HERMES), 'x-agw-purpose': 'not a purpose!' },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ text: 'hallo' })
      const runId = res.headers.get('agw-run-id')
      expect(runId).toBeTruthy()
      expect(await sql.run(runId as string)).toBeUndefined()
    } finally {
      await audio.shutdown()
    }
  })

  test('only the exact door paths are the door: a workflow path that ends like one reaches the API', async () => {
    const audio = await start(stubHandlers())
    try {
      for (const path of ['/workflows/audio/speech', '/v2/audio/speech', '/v1/audio/speech/x']) {
        const res = await fetch(`${audio.url}${path}`, { method: 'POST', body: '{}', headers: bearer(HERMES) })
        // The API's own answer to a door token: its 401 envelope, not the door's.
        expect(res.status).toBe(401)
        expect(((await res.json()) as { code?: string }).code).toBe('UNAUTHORIZED')
      }
    } finally {
      await audio.shutdown()
    }
  })

  test('a client that goes away mid-stream ends the record: the run finishes incomplete, it never stays running', async () => {
    const handlers: DoorHandlers = {
      speech: (deps) => async (req) => {
        deps.usage.record(call(deps, req))
        // A stream that never ends on its own: only the client going away stops it.
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new Uint8Array(1024)),
        })
        return new Response(body, { headers: { 'content-type': 'audio/pcm' } })
      },
      transcriptions: () => async () => Response.json({ text: '' }),
    }
    const audio = await start(handlers)
    try {
      const abort = new AbortController()
      const res = await fetch(`${audio.url}/v1/audio/speech`, {
        method: 'POST',
        body: '{}',
        headers: bearer(HERMES),
        signal: abort.signal,
      })
      const runId = res.headers.get('agw-run-id') as string
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      abort.abort()
      await reader.read().catch(() => undefined)
      const done = await until(
        async () => {
          const row = await sql.run(runId)
          return row?.status === 'done' ? row : undefined
        },
        'the cut run',
        15_000,
      )
      expect(done.output).toMatchObject({ calls: 1, complete: false, costUsd: 0.002 })
    } finally {
      await audio.shutdown()
    }
  }, 30_000)

  // Explicit timeout: the first process's shutdown holds the cut request for the server's 5 s grace.
  test('a request cut by a restart: the next process fails its run as lost, it never hangs', async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = await start(stubHandlers(hold))
    let second: (RunningHost & { url: string }) | undefined
    try {
      const body = JSON.stringify({ model: 'tts-1', input: 'Hallo', voice: 'Charon' })
      const cut = fetch(`${first.url}/v1/audio/speech`, { method: 'POST', body, headers: bearer(HERMES) }).catch(
        () => 'cut',
      )
      const runId = await until(async () => {
        const { rows } = await sql.pool.query(
          `select id from "${db.schema}".runs where workflow = $1 and status = 'running' and input->>'caller' = 'hermes'
           and id not in (select run_id from "${db.schema}".steps where status <> 'running')`,
          [DOOR_WORKFLOW_IDS.speech],
        )
        return (rows[0] as { id: string } | undefined)?.id
      }, 'the running door run')
      await first.shutdown()
      release()
      await cut
      second = await start(stubHandlers())
      const failed = await until(
        async () => {
          const row = await sql.run(runId)
          return row?.status === 'failed' ? row : undefined
        },
        'the lost run',
        15_000,
      )
      expect(String(failed.error)).toContain('its usage is lost')
    } finally {
      release()
      await second?.shutdown()
      await first.shutdown()
    }
  }, 30_000)
})

const PLATFORM = 'agw'
const LITE = audioRoutes()['audio.tts.gemini-flash-lite'].model
