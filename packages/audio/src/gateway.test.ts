import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createSpeechHandler } from './door/speech.ts'
import { createTranscriptionsHandler } from './door/transcriptions.ts'
import { gatewayHeaders } from './gateway.ts'
import { audioRoutes } from './routes.ts'
import { createAudioScope } from './scope.ts'
import { callPrepLlm, GEMINI_PREP_SYSTEM_PROMPT } from './speech/prep.ts'
import {
  audioEvent,
  caught,
  type FakeGateway,
  type FakeRoute,
  geminiAudio,
  hasFfmpeg,
  messageAnswer,
  prepAnswer,
  realMedia,
  startFakeGateway,
  streamBody,
  TEST_TOKEN,
  testDeps,
  toneFile,
} from './testing/index.ts'
import type { CallEvent } from './usage.ts'

const ROUTES = audioRoutes()
const ATTRIBUTION = {
  runId: 'run-1',
  rootId: 'root-1',
  workflow: 'podcast.produce.unit',
  step: 'synth',
  purpose: 'prod',
  project: 'agw',
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
}
const DELIVERY_URL = 'https://abc.replicate.delivery/out.mp3'

let gateway: FakeGateway
afterEach(() => gateway?.stop())

/** Routes agw prices itself; every other gateway-bound route is a text call whose row the gateway writes. */
const MEDIA: FakeRoute[] = ['gemini', 'geminiStream', 'replicateCreate', 'replicatePoll', 'transcriptions']
const TEXT: FakeRoute[] = ['chat', 'messages']

describe('gatewayHeaders', () => {
  test('maps the attribution to the x-agw headers; the session is the root run', () => {
    expect(gatewayHeaders(ATTRIBUTION)).toEqual({
      'x-agw-session': 'root-1',
      'x-agw-run-id': 'run-1',
      'x-agw-workflow': 'podcast.produce.unit',
      'x-agw-step': 'synth',
      'x-agw-purpose': 'prod',
      'x-agw-project': 'agw',
      traceparent: ATTRIBUTION.traceparent,
    })
    expect(gatewayHeaders(undefined)).toEqual({})
  })

  test('a value that is not printable ASCII up to 200 characters, or has a space at either end, is left out', () => {
    const headers = gatewayHeaders({
      ...ATTRIBUTION,
      project: 'ünï',
      workspace: ' work',
      step: 'x'.repeat(201),
      purpose: 'a b',
    })
    expect(headers['x-agw-project']).toBeUndefined()
    expect(headers['x-agw-workspace']).toBeUndefined()
    expect(headers['x-agw-step']).toBeUndefined()
    expect(headers['x-agw-purpose']).toBe('a b')
  })
})

describe('headers per lane', () => {
  let mp3: Uint8Array<ArrayBuffer>
  let wav: Uint8Array<ArrayBuffer>
  beforeAll(async () => {
    if (!hasFfmpeg) return
    mp3 = await toneFile(0.5, { format: 'mp3' })
    wav = await toneFile(2)
  })

  function setup(handlers: Parameters<typeof startFakeGateway>[0]) {
    gateway = startFakeGateway(handlers)
    const deps = testDeps(gateway, { media: realMedia(), attribution: () => ATTRIBUTION })
    return { deps, speak: createSpeechHandler(deps), transcribe: createTranscriptionsHandler(deps) }
  }

  const speech = (body: Record<string, unknown>) =>
    new Request('http://door/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  /** The headers of the requests on `routes`, in order. */
  const headersOf = (...routes: FakeRoute[]) =>
    gateway.requests.filter((r) => routes.includes(r.route)).map((r) => r.headers)

  function expectAttributed(headers: Headers[]) {
    expect(headers.length).toBeGreaterThan(0)
    for (const h of headers) {
      expect(h.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`)
      expect(h.get('x-agw-session')).toBe('root-1')
      expect(h.get('x-agw-run-id')).toBe('run-1')
      expect(h.get('x-agw-workflow')).toBe('podcast.produce.unit')
      expect(h.get('x-agw-step')).toBe('synth')
      expect(h.get('x-agw-project')).toBe('agw')
      expect(h.get('traceparent')).toBe(ATTRIBUTION.traceparent)
    }
  }

  test('Gemini TTS, unary and streamed: bearer, attribution and x-agw-usage: caller', async () => {
    const { speak } = setup({
      gemini: () => geminiAudio(new Uint8Array(4800)),
      geminiStream: () => streamBody(audioEvent(new Uint8Array(4800))),
    })
    const model = ROUTES['audio.tts.gemini-flash-lite'].model
    expect((await speak(speech({ model, input: 'Hallo.', voice: 'Charon', response_format: 'wav' }))).status).toBe(200)
    const streamed = await speak(speech({ model, input: 'Hallo.', voice: 'Charon', response_format: 'pcm' }))
    expect(streamed.status).toBe(200)
    await streamed.arrayBuffer()
    const headers = headersOf('gemini', 'geminiStream')
    expect(headers).toHaveLength(2)
    expectAttributed(headers)
    for (const h of headers) expect(h.get('x-agw-usage')).toBe('caller')
  })

  test.skipIf(!hasFfmpeg)(
    'Replicate create and poll carry x-agw-usage: caller; the delivery fetch carries nothing',
    async () => {
      const { speak } = setup({
        replicateCreate: () => Response.json({ id: 'p1', status: 'processing' }),
        replicatePoll: () =>
          Response.json({ id: 'p1', status: 'succeeded', output: DELIVERY_URL, metrics: { predict_time: 1 } }),
        delivery: () => new Response(mp3),
      })
      const model = ROUTES['audio.tts.elevenlabs-flash'].model
      const res = await speak(speech({ model, input: 'Hallo.', voice: 'Mark' }))
      expect(res.status).toBe(200)
      const headers = headersOf('replicateCreate', 'replicatePoll')
      expect(headers).toHaveLength(2)
      expectAttributed(headers)
      for (const h of headers) expect(h.get('x-agw-usage')).toBe('caller')
      // replicate.delivery is not the gateway: no credential and no attribution leave with it.
      const [delivery] = headersOf('delivery')
      expect(delivery?.get('authorization')).toBeNull()
      expect(delivery?.get('x-agw-run-id')).toBeNull()
      expect(delivery?.get('x-agw-usage')).toBeNull()
    },
  )

  test.skipIf(!hasFfmpeg)('transcriptions carry x-agw-usage: caller', async () => {
    const { transcribe } = setup({ transcriptions: () => Response.json({ text: 'hallo' }) })
    const form = new FormData()
    form.append('file', new File([wav], 'clip.wav', { type: 'audio/wav' }))
    expect(
      (await transcribe(new Request('http://door/v1/audio/transcriptions', { method: 'POST', body: form }))).status,
    ).toBe(200)
    const headers = headersOf('transcriptions')
    expectAttributed(headers)
    expect(headers[0]?.get('x-agw-usage')).toBe('caller')
  })

  test('the prep call is a text call: attributed, and no x-agw-usage; the synth it feeds is media', async () => {
    const { speak } = setup({
      chat: () => prepAnswer({ lang: 'de', title: 'T', chunks: [{ text: 'Hallo.' }] }),
      gemini: () => geminiAudio(new Uint8Array(4800)),
    })
    const model = ROUTES['audio.tts.gemini-flash'].model
    expect((await speak(speech({ model, input: 'Hallo.', voice: 'Charon', response_format: 'wav' }))).status).toBe(200)
    const [chat] = headersOf('chat')
    expectAttributed([chat as Headers])
    expect(chat?.get('x-agw-usage')).toBeNull()
    expect(chat?.get('x-agw-fallback')).toBeNull()
    expect(headersOf('gemini')[0]?.get('x-agw-usage')).toBe('caller')
  })

  test('x-agw-usage: caller is on exactly the media calls of a whole request', async () => {
    const { speak } = setup({
      chat: () => prepAnswer({ lang: 'de', title: 'T', chunks: [{ text: 'Hallo.' }] }),
      gemini: () => geminiAudio(new Uint8Array(4800)),
    })
    const model = ROUTES['audio.tts.gemini-flash'].model
    await speak(speech({ model, input: 'Hallo.', voice: 'Charon', response_format: 'wav' }))
    const withUsage = gateway.requests.filter((r) => r.headers.get('x-agw-usage') === 'caller').map((r) => r.route)
    const without = gateway.requests.filter((r) => r.headers.get('x-agw-usage') === null).map((r) => r.route)
    expect(withUsage.length).toBeGreaterThan(0)
    expect(withUsage.every((route) => MEDIA.includes(route))).toBe(true)
    expect(without.every((route) => TEXT.includes(route))).toBe(true)
    expect(
      gateway.requests.some((r) => r.headers.get('x-agw-usage') !== null && r.headers.get('x-agw-usage') !== 'caller'),
    ).toBe(false)
  })

  test('without attribution only the bearer (and the media marker) are sent', async () => {
    gateway = startFakeGateway({ gemini: () => geminiAudio(new Uint8Array(4800)) })
    const speak = createSpeechHandler(testDeps(gateway))
    const model = ROUTES['audio.tts.gemini-flash-lite'].model
    await speak(speech({ model, input: 'Hallo.', voice: 'Charon', response_format: 'wav' }))
    const h = headersOf('gemini')[0]
    expect(h?.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`)
    expect(h?.get('x-agw-usage')).toBe('caller')
    expect([...(h?.keys() ?? [])].filter((k) => k.startsWith('x-agw-') && k !== 'x-agw-usage')).toEqual([])
  })
})

describe('the prep call on the route wire', () => {
  const PREP = JSON.stringify({ lang: 'de', title: 'T', chunks: [{ text: 'Hallo.' }] })
  const input = { systemPrompt: GEMINI_PREP_SYSTEM_PROMPT, userContent: 'Hallo.', inputChars: 6, summarize: false }

  /** A scope whose prep route is what the seats put on it: the `anthropic` wire, with a fallback on `iu-openai`. */
  function seatsScope(fallback: boolean) {
    const deps = testDeps(gateway, { attribution: () => ATTRIBUTION })
    const scope = createAudioScope(deps, { requestId: 'r1', caller: 'test', attribution: ATTRIBUTION })
    const prep = scope.route('audio.tts.prep')
    scope.deps.routes = {
      ...scope.deps.routes,
      'audio.tts.prep': {
        ...prep,
        wire: 'anthropic',
        model: 'seat-model',
        effort: 'low',
        rate: { inputPerM: 1, outputPerM: 5 },
        ...(fallback && {
          fallback: {
            wire: 'iu-openai',
            model: 'fallback-model',
            effort: 'low',
            rate: { inputPerM: 0.1, outputPerM: 0.5 },
          },
        }),
      },
    }
    return { scope, deps }
  }
  const calls = (deps: { usage: { events: unknown[] } }) =>
    deps.usage.events.filter((e) => (e as CallEvent).kind === 'call') as CallEvent[]

  test('on the anthropic wire it posts a Messages request with x-agw-fallback: none and no x-agw-usage', async () => {
    gateway = startFakeGateway({
      messages: () => messageAnswer(PREP, { input_tokens: 1000, output_tokens: 200 }),
    })
    const { scope, deps } = seatsScope(true)
    const prep = await callPrepLlm(scope, input)
    expect(prep.chunks).toHaveLength(1)
    expect(gateway.requests.map((r) => r.route)).toEqual(['messages'])
    const request = gateway.requests[0]
    expect(request?.path).toBe('/anthropic/v1/messages')
    const h = request?.headers
    expect(h?.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`)
    expect(h?.get('anthropic-version')).toBe('2023-06-01')
    expect(h?.get('x-agw-fallback')).toBe('none')
    expect(h?.get('x-agw-usage')).toBeNull()
    expect(h?.get('x-agw-session')).toBe('root-1')
    expect(h?.get('x-agw-step')).toBe('synth')
    expect(request?.json).toMatchObject({
      model: 'seat-model',
      system: GEMINI_PREP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hallo.' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    })
    expect(request?.json).not.toHaveProperty('reasoning_effort')
    expect(request?.json).not.toHaveProperty('max_completion_tokens')
    // Priced from the Messages usage at the route's rate: the run record does not change.
    expect(calls(deps)).toMatchObject([
      { endpoint: 'speech-prep', model: 'seat-model', costSource: 'rate', inputTokens: 1000, outputTokens: 200 },
    ])
    expect(calls(deps)[0]?.costUsd).toBeCloseTo((1000 * 1 + 200 * 5) / 1e6, 10)
  })

  test('a balance failure (402) moves the call once to the route fallback, priced at the fallback rate', async () => {
    gateway = startFakeGateway({
      messages: () => new Response('{"type":"error","error":{"type":"billing_error"}}', { status: 402 }),
      chat: () => prepAnswer(JSON.parse(PREP)),
    })
    const { scope, deps } = seatsScope(true)
    const prep = await callPrepLlm(scope, input)
    expect(prep.chunks).toHaveLength(1)
    expect(gateway.requests.map((r) => r.route)).toEqual(['messages', 'chat'])
    const fallback = gateway.requests[1]
    expect(fallback?.json).toMatchObject({ model: 'fallback-model', reasoning_effort: 'low' })
    expect(fallback?.headers.get('x-agw-fallback')).toBeNull()
    expect(fallback?.headers.get('x-agw-usage')).toBeNull()
    expect(fallback?.headers.get('x-agw-session')).toBe('root-1')
    const events = calls(deps)
    expect(events).toMatchObject([
      { model: 'seat-model', status: 402, costSource: 'not-billed', costUsd: 0 },
      { model: 'fallback-model', status: 200, costSource: 'rate' },
    ])
    // chat usage is prompt_tokens 100 / completion_tokens 50 at the fallback's rate, not the seat's
    expect(events[1]?.costUsd).toBeCloseTo((100 * 0.1 + 50 * 0.5) / 1e6, 10)
  })

  test('a failure that is not a balance failure, or a balance failure with no fallback, is thrown', async () => {
    gateway = startFakeGateway({
      messages: () => new Response('{"type":"error","error":{"type":"invalid_request_error"}}', { status: 400 }),
      chat: () => prepAnswer(JSON.parse(PREP)),
    })
    const bad = seatsScope(true)
    expect((await caught(callPrepLlm(bad.scope, input))).message).toMatch(/HTTP 400/)
    expect(gateway.requests.map((r) => r.route)).toEqual(['messages'])

    gateway.on('messages', () => new Response('', { status: 402 }))
    gateway.requests.length = 0
    const none = seatsScope(false)
    expect((await caught(callPrepLlm(none.scope, input))).message).toMatch(/HTTP 402/)
    expect(gateway.requests.map((r) => r.route)).toEqual(['messages'])
  })

  test('the summary route dispatches on its wire too, with no effort', async () => {
    gateway = startFakeGateway({ messages: () => messageAnswer(PREP) })
    const { scope } = seatsScope(false)
    const summary = scope.route('audio.tts.summary')
    scope.deps.routes = {
      ...scope.deps.routes,
      'audio.tts.summary': { ...summary, wire: 'anthropic', model: 'seat-model', effort: 'low' },
    }
    await callPrepLlm(scope, { ...input, summarize: true })
    expect(gateway.requests[0]?.path).toBe('/anthropic/v1/messages')
    expect(gateway.requests[0]?.json).not.toHaveProperty('thinking')
  })

  test('a route on a wire that is not a text wire fails loudly', async () => {
    gateway = startFakeGateway({})
    const { scope } = seatsScope(false)
    const prep = scope.route('audio.tts.prep')
    scope.deps.routes = { ...scope.deps.routes, 'audio.tts.prep': { ...prep, wire: 'iu-gemini' } }
    expect((await caught(callPrepLlm(scope, input))).message).toMatch(/iu-gemini wire/)
  })
})
