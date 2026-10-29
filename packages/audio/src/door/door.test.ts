import { afterEach, describe, expect, test } from 'bun:test'
import { audioRoutes } from '../routes.ts'

const ROUTES = audioRoutes()
import {
  audioEvent,
  type FakeIu,
  geminiAudio,
  hasFfmpeg,
  startFakeIu,
  streamBody,
  testDeps,
  toneFile,
} from '../testing/index.ts'
import type { RequestEvent, UsageEvent } from '../usage.ts'
import { createSpeechHandler } from './speech.ts'
import { createTranscriptionsHandler } from './transcriptions.ts'

const LITE = ROUTES['audio.tts.gemini-flash-lite'].model
const VOXTRAL = ROUTES['audio.stt.voxtral-mini'].model

let iu: FakeIu
let door: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  iu?.stop()
  void door?.stop(true)
  door = undefined
})

/** The audio process's shape: both handlers on one server, routed by path suffix like audio-gateway. */
function mount(deps: Parameters<typeof createSpeechHandler>[0]): string {
  const speech = createSpeechHandler(deps)
  const transcriptions = createTranscriptionsHandler(deps)
  door = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/audio/speech')) return speech(req)
      if (req.method === 'POST' && path.endsWith('/audio/transcriptions')) return transcriptions(req)
      return new Response('not found', { status: 404 })
    },
  })
  return `http://127.0.0.1:${door.port}/v1`
}

/** What the OpenAI SDK sends: bearer auth, JSON for speech, multipart for transcriptions. */
const sdkHeaders = { authorization: 'Bearer sk-hermes', 'user-agent': 'OpenAI/Python 2.0' }

describe.skipIf(!hasFfmpeg)('both handlers mounted on Bun.serve (acceptance)', () => {
  test('an OpenAI SDK-shaped client gets mp3, a pcm stream and a verbose_json transcript from the fakes', async () => {
    iu = startFakeIu({
      gemini: () => geminiAudio(new Uint8Array(24_000)),
      geminiStream: () => streamBody(audioEvent(new Uint8Array(4800)), audioEvent(new Uint8Array(4800))),
      transcriptions: () => Response.json({ text: 'Hallo Welt', language: null, usage: { prompt_audio_seconds: 2 } }),
    })
    const deps = testDeps(iu)
    const base = mount(deps)

    const mp3 = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { ...sdkHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: LITE, input: 'Guten Morgen.', voice: 'Charon', response_format: 'mp3' }),
    })
    expect(mp3.status).toBe(200)
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg')
    expect(mp3.headers.get('x-audio-title')).toBe(encodeURIComponent('Guten Morgen'))
    const mp3Bytes = new Uint8Array(await mp3.arrayBuffer())
    // An MPEG frame sync (or an ID3 tag) up front.
    expect(mp3Bytes[0] === 0xff || new TextDecoder().decode(mp3Bytes.subarray(0, 3)) === 'ID3').toBe(true)

    const pcm = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { ...sdkHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: LITE, input: 'Hallo.', voice: 'Charon', response_format: 'pcm' }),
    })
    expect(pcm.status).toBe(200)
    expect(pcm.headers.get('content-type')).toBe('audio/pcm')
    let received = 0
    const reader = pcm.body?.getReader()
    for (;;) {
      const chunk = await reader?.read()
      if (!chunk || chunk.done) break
      received += chunk.value.byteLength
    }
    expect(received).toBe(9600)

    const form = new FormData()
    form.append('file', new File([await toneFile(2)], 'voice.wav', { type: 'audio/wav' }))
    form.append('model', VOXTRAL)
    form.append('response_format', 'verbose_json')
    const stt = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: sdkHeaders, body: form })
    expect(stt.status).toBe(200)
    const transcript = (await stt.json()) as {
      text: string
      duration: number
      segments: Array<{ start: number; end: number; text: string }>
    }
    expect(transcript.text).toBe('Hallo Welt')
    expect(transcript.segments).toEqual([expect.objectContaining({ start: 0, text: 'Hallo Welt' })])
    expect(Math.abs(transcript.duration - 2)).toBeLessThan(0.2)

    await deps.usage.settledSummary()
    const requests = deps.usage.events.filter((e): e is RequestEvent => e.kind === 'request')
    expect(requests.map((e) => e.endpoint).sort()).toEqual([
      'speech-request',
      'speech-request',
      'transcription-request',
    ])
    for (const e of requests) expect(e.costSource).toBe('rate')
  })
})

describe('door contract', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://door/v1/audio/speech', { method: 'POST', headers, body })

  test('a body that is not JSON is a 400 with no usage event', async () => {
    iu = startFakeIu()
    const deps = testDeps(iu)
    const res = await createSpeechHandler(deps)(post('model=x'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { message: 'request body must be valid JSON', type: 'invalid_request_error' },
    })
    expect(deps.usage.events).toHaveLength(0)
  })

  test('an unknown response_format is a 400 before dispatch', async () => {
    iu = startFakeIu()
    const res = await createSpeechHandler(testDeps(iu))(post(JSON.stringify({ input: 'x', response_format: 'flac' })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'unsupported response_format: flac',
    )
    expect(iu.requests).toHaveLength(0)
  })

  test('empty input is a 400 from the lane', async () => {
    iu = startFakeIu()
    const res = await createSpeechHandler(testDeps(iu))(post(JSON.stringify({ input: '  ' })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('input is required')
  })

  test('a wrong model lands on the default route; caller and request id stamp every event', async () => {
    iu = startFakeIu({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    const deps = {
      ...testDeps(iu),
      caller: () => 'hermes',
      requestId: (req: Request) => req.headers.get('x-request-id') ?? 'none',
    }
    const speak = createSpeechHandler(deps)
    await speak(post(JSON.stringify({ model: 'tts-1', input: 'Hallo.' }), { 'x-request-id': 'req-7' }))
    await speak(post(JSON.stringify({ input: 'Hallo.' }), { 'x-audio-source': 'slack', 'x-request-id': 'req-8' }))
    expect(iu.requests.map((r) => r.path)).toEqual([
      `/gemini/v1beta/models/${LITE}:generateContent`,
      `/gemini/v1beta/models/${LITE}:generateContent`,
    ])
    expect(deps.usage.events.map((e) => [e.kind, e.requestId, e.caller])).toEqual([
      ['call', 'req-7', 'hermes'],
      ['request', 'req-7', 'hermes'],
      ['call', 'req-8', 'slack'],
      ['request', 'req-8', 'slack'],
    ])
    expect((deps.usage.events[1] as RequestEvent).requestedModel).toBe('tts-1')
  })

  test('a usage port that throws or rejects never breaks the response', async () => {
    iu = startFakeIu({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    const warnings: string[] = []
    const deps = {
      ...testDeps(iu),
      log: { info: () => {}, error: () => {}, warn: (m: string) => void warnings.push(m) },
      usage: {
        record: (event: UsageEvent) => {
          if (event.kind === 'call') throw new Error('db down')
          return Promise.reject(new Error('db down'))
        },
      },
    }
    const res = await createSpeechHandler(deps)(post(JSON.stringify({ input: 'Hallo.' })))
    expect(res.status).toBe(200)
    expect(warnings[0]).toBe('usage port failed')
  })

  test('a TTS id the route table does not serve (a retired Gemini preview, any owner/name) lands on the default', async () => {
    iu = startFakeIu({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    const deps = testDeps(iu)
    const speak = createSpeechHandler(deps)
    await speak(post(JSON.stringify({ model: 'gemini-3.1-flash-tts-preview', input: 'Hallo.' })))
    await speak(post(JSON.stringify({ model: 'someone/voice-1', input: 'Hallo.' })))
    expect(iu.requests.map((r) => r.path)).toEqual([
      `/gemini/v1beta/models/${LITE}:generateContent`,
      `/gemini/v1beta/models/${LITE}:generateContent`,
    ])
  })
})
