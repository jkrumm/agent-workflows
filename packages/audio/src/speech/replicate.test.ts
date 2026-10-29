import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createSpeechHandler } from '../door/speech.ts'
import { audioRoutes } from '../routes.ts'

const ROUTES = audioRoutes()
import { createAudioScope } from '../scope.ts'
import { caught, type FakeIu, hasFfmpeg, prepAnswer, startFakeIu, testDeps, toneFile } from '../testing/index.ts'
import type { CallEvent, RequestEvent, UsageEvent } from '../usage.ts'
import { ReplicateSynthError, synthReplicateChunk } from './replicate.ts'

const FLASH = ROUTES['audio.tts.elevenlabs-flash'].model
const V3 = ROUTES['audio.tts.elevenlabs-v3'].model
const DELIVERY_URL = 'https://abc.replicate.delivery/out.mp3'

let mp3: Uint8Array<ArrayBuffer>
beforeAll(async () => {
  if (hasFfmpeg) mp3 = await toneFile(0.5, { format: 'mp3' })
})

let iu: FakeIu
afterEach(() => iu?.stop())

const succeeded = (id = 'p1') =>
  Response.json({ id, status: 'succeeded', output: DELIVERY_URL, metrics: { predict_time: 1 } })

function setup(handlers: Parameters<typeof startFakeIu>[0] = {}, config = {}) {
  iu = startFakeIu({
    replicateCreate: () => succeeded(),
    delivery: () => new Response(mp3),
    ...handlers,
  })
  const deps = testDeps(iu, { config })
  return { deps, speak: createSpeechHandler(deps) }
}

const post = (body: Record<string, unknown>) =>
  new Request('http://door/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const calls = (events: UsageEvent[]) => events.filter((e): e is CallEvent => e.kind === 'call')
const summary = (events: UsageEvent[]) => events.find((e): e is RequestEvent => e.kind === 'request')
const predictionInputs = () =>
  iu.requests
    .filter((r) => r.route === 'replicateCreate')
    .map((r) => (r.json as { input: Record<string, unknown> }).input)

describe.skipIf(!hasFfmpeg)('replicate lane', () => {
  test('single-chunk mp3: one prediction, one delivery fetch, the bytes as delivered, no prep, no title', async () => {
    const { deps, speak } = setup()
    const res = await speak(post({ model: FLASH, input: 'Guten Morgen Johannes.', voice: 'Roger' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.has('x-audio-title')).toBe(false)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(mp3)
    expect(iu.requests.map((r) => r.route)).toEqual(['replicateCreate', 'delivery'])
    expect(iu.requests[0]?.path).toBe(`/replicate/v1/models/${FLASH}/predictions`)
    expect(iu.requests[0]?.headers.get('prefer')).toBe('wait')
    expect(predictionInputs()[0]).toMatchObject({ voice: 'Roger', language_code: 'de', stability: 0.5, style: 0 })
    const [call] = calls(deps.usage.events)
    expect(call).toMatchObject({ routeId: 'audio.tts.elevenlabs-flash', units: 'characters', quantity: 22 })
    expect(call?.costUsd).toBeCloseTo((22 / 1000) * 0.05, 12)
    expect(summary(deps.usage.events)).toMatchObject({ lane: 'replicate', mode: 'direct', status: 200 })
  })

  test('processing -> poll -> succeeded', async () => {
    const { speak } = setup({
      replicateCreate: () => Response.json({ id: 'p2', status: 'processing' }),
      replicatePoll: (_r, attempt) =>
        attempt < 2 ? Response.json({ id: 'p2', status: 'processing' }) : succeeded('p2'),
    })
    const res = await speak(post({ model: FLASH, input: 'Poll me.' }))
    expect(res.status).toBe(200)
    expect(iu.requests.filter((r) => r.route === 'replicatePoll').map((r) => r.path)).toEqual([
      '/replicate/v1/predictions/p2',
      '/replicate/v1/predictions/p2',
    ])
  })

  test('prep runs for v3: chat completions with the prep effort, and the title header is set', async () => {
    const { speak } = setup({
      chat: () =>
        prepAnswer({ lang: 'de', title: 'Kurzer Gruß', chunks: [{ style: 'ruhig', text: '[sighs] Hallo.' }] }),
    })
    const res = await speak(post({ model: V3, input: 'Hallo.' }))
    expect(decodeURIComponent(res.headers.get('x-audio-title') ?? '')).toBe('Kurzer Gruß')
    const chat = iu.requests.find((r) => r.route === 'chat')
    expect(chat?.json?.reasoning_effort).toBe('low')
    expect(predictionInputs()[0]?.prompt).toBe('[sighs] Hallo.')
  })

  test('v3 never receives previous_text/next_text; flash gets them across sentence-split chunks', async () => {
    const sentence = `${Array.from({ length: 70 }, () => 'wort').join(' ')}.`
    const { speak } = setup({
      chat: () =>
        prepAnswer({
          lang: 'de',
          title: 'T',
          chunks: [
            { style: '', text: 'Eins.' },
            { style: '', text: 'Zwei.' },
          ],
        }),
    })
    await speak(post({ model: V3, input: 'Eins. Zwei.' }))
    for (const input of predictionInputs()) {
      expect(input.previous_text).toBeUndefined()
      expect(input.next_text).toBeUndefined()
    }
    iu.requests.length = 0
    await speak(post({ model: FLASH, input: `${sentence} ${sentence}`, response_format: 'pcm' }))
    const inputs = predictionInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.next_text).toBe(inputs[1]?.prompt)
    expect(inputs[1]?.previous_text).toBe(inputs[0]?.prompt)
  })

  test('pcm is transcoded and labelled audio/pcm; speed is clamped, and exactly 1 is omitted', async () => {
    const { speak } = setup()
    const res = await speak(post({ model: FLASH, input: 'Hallo.', response_format: 'pcm', speed: 3 }))
    expect(res.headers.get('content-type')).toBe('audio/pcm')
    expect((await res.arrayBuffer()).byteLength % 2).toBe(0)
    await speak(post({ model: FLASH, input: 'Hallo.', speed: 1 }))
    expect(predictionInputs().map((i) => i.speed)).toEqual([1.2, undefined])
  })

  test('summarize on a prep-off model uses the summary prompt, one prediction, title header', async () => {
    const { deps, speak } = setup({
      chat: () => prepAnswer({ lang: 'de', title: 'Todo', chunks: [{ style: '', text: 'Todo angelegt.' }] }),
    })
    const res = await speak(post({ model: FLASH, input: 'Ich habe das Todo angelegt.', summarize: true }))
    expect(decodeURIComponent(res.headers.get('x-audio-title') ?? '')).toBe('Todo')
    const chat = iu.requests.find((r) => r.route === 'chat')
    expect((chat?.json as { messages: Array<{ content: string }> } | undefined)?.messages[0]?.content).toContain(
      'what should be SPOKEN aloud',
    )
    expect(chat?.json?.model).toBe(ROUTES['audio.tts.summary'].model)
    expect(predictionInputs()).toHaveLength(1)
    expect(summary(deps.usage.events)?.mode).toBe('summary')
  })

  describe('door-side auto-summarize for whole-file clients', () => {
    const LONG = `Erledigt! Ich habe das Todo Serverrechnung bezahlen für morgen angelegt. ${'Weitere Details, die man lesen kann. '.repeat(6)}`
    const handlers = {
      chat: () => prepAnswer({ lang: 'de', title: 'Todo', chunks: [{ style: '', text: 'Todo angelegt.' }] }),
    }
    test('a long mp3 request on flash is summarized without the client asking', async () => {
      const { speak } = setup(handlers)
      expect((await speak(post({ model: FLASH, input: LONG }))).status).toBe(200)
      expect(iu.requests.filter((r) => r.route === 'chat')).toHaveLength(1)
    })
    test('the same text as pcm (a streaming sentence) is never summarized', async () => {
      const { speak } = setup(handlers)
      expect((await speak(post({ model: FLASH, input: LONG, response_format: 'pcm' }))).status).toBe(200)
      expect(iu.requests.filter((r) => r.route === 'chat')).toHaveLength(0)
    })
    test('short mp3 requests stay direct', async () => {
      const { speak } = setup(handlers)
      expect((await speak(post({ model: FLASH, input: 'Alles klar, erledigt.' }))).status).toBe(200)
      expect(iu.requests.filter((r) => r.route === 'chat')).toHaveLength(0)
    })
  })

  test('a failed prediction is a 502 proxy_error with a not-billed call event', async () => {
    const { deps, speak } = setup({
      replicateCreate: () => Response.json({ id: 'p3', status: 'failed', error: 'voice not found' }),
    })
    const res = await speak(post({ model: FLASH, input: 'Hallo.' }))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string; type: string } }
    expect(body.error).toMatchObject({ type: 'proxy_error' })
    expect(body.error.message).toContain('voice not found')
    expect(calls(deps.usage.events)[0]).toMatchObject({ status: 502, costSource: 'not-billed' })
    expect(summary(deps.usage.events)?.status).toBe(502)
  })

  test('a delivery URL off replicate.delivery is refused (no open fetch)', async () => {
    const { speak } = setup({
      replicateCreate: () => Response.json({ id: 'p4', status: 'succeeded', output: 'https://evil.example/x.mp3' }),
    })
    expect((await speak(post({ model: FLASH, input: 'Hallo.' }))).status).toBe(502)
    expect(iu.requests.map((r) => r.route)).toEqual(['replicateCreate'])
  })

  test('synthReplicateChunk (podcast per-turn synth) records on the caller scope and throws ReplicateSynthError', async () => {
    const { deps } = setup()
    const scope = createAudioScope(deps, { requestId: 'episode-1', caller: 'podcast' })
    const params = {
      routeId: 'audio.tts.elevenlabs-v3',
      text: 'Hallo zusammen.',
      voice: 'Mark',
      languageCode: 'de',
      stability: 0.5,
      style: 0,
      similarityBoost: 0.75,
      previousText: 'Vorher.',
    }
    const turn = await synthReplicateChunk(scope, params)
    expect(turn.mp3).toEqual(mp3)
    expect(turn.pcm.byteLength).toBeGreaterThan(0)
    expect(predictionInputs()[0]?.previous_text).toBeUndefined()
    iu.on('replicateCreate', () => Response.json({ id: 'p5', status: 'canceled' }))
    expect(await caught(synthReplicateChunk(scope, params))).toBeInstanceOf(ReplicateSynthError)
    expect(calls(deps.usage.events).map((e) => [e.requestId, e.status])).toEqual([
      ['episode-1', 200],
      ['episode-1', 502],
    ])
  })

  test('a prediction that succeeded is billed by its characters even when the delivery fetch fails', async () => {
    const { deps, speak } = setup({ delivery: () => new Response('gone', { status: 404 }) })
    const res = await speak(post({ model: FLASH, input: 'Hallo Welt.' }))
    expect(res.status).toBe(502)
    const [call] = calls(deps.usage.events)
    expect(call).toMatchObject({ status: 200, inputChars: 11, costSource: 'rate' })
    expect(call?.costUsd).toBeCloseTo((11 / 1000) * 0.05, 12)
    expect(call?.errorText).toContain('HTTP 404')
  })

  test('an unreadable prediction body is a 502, not a 500', async () => {
    const { deps, speak } = setup({ replicateCreate: () => new Response('<html>oops</html>') })
    const res = await speak(post({ model: FLASH, input: 'Hallo.' }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('unreadable body')
    expect(calls(deps.usage.events)[0]).toMatchObject({ status: 502, costSource: 'not-billed' })
  })

  test('the delivery fetch refuses a redirect off the allowlisted host', async () => {
    const { speak } = setup({
      delivery: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp3' } }),
    })
    expect((await speak(post({ model: FLASH, input: 'Hallo.' }))).status).toBe(502)
  })

  test('the prediction id is URL-encoded in the poll path', async () => {
    const { speak } = setup({
      replicateCreate: () => Response.json({ id: 'p/../x?y', status: 'processing' }),
      replicatePoll: () => succeeded('p/../x?y'),
    })
    expect((await speak(post({ model: FLASH, input: 'Hallo.' }))).status).toBe(200)
    expect(iu.requests.find((r) => r.route === 'replicatePoll')?.path).toBe(
      `/replicate/v1/predictions/${encodeURIComponent('p/../x?y')}`,
    )
  })
})
