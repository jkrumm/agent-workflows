import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { AudioConfig } from '../config.ts'
import { ffmpegMedia, type MediaPort } from '../media/audio.ts'
import { AUDIO_ROUTES } from '../routes.pending.ts'
import { type FakeIu, type FakeRequest, hasFfmpeg, startFakeIu, testDeps, toneFile } from '../testing/index.ts'
import type { CallEvent, RequestEvent, UsageEvent } from '../usage.ts'
import { createTranscriptionsHandler } from './transcriptions.ts'

const VOXTRAL = AUDIO_ROUTES['audio.stt.voxtral-mini'].model
const GPT_TRANSCRIBE = AUDIO_ROUTES['audio.stt.gpt-transcribe'].model
const GPT_4O = AUDIO_ROUTES['audio.stt.gpt-4o-transcribe'].model
const WHISPER = AUDIO_ROUTES['audio.stt.whisper'].model
const PROMPT = 'Die Aufnahme ist auf Deutsch oder Englisch.'

let tenSeconds: Uint8Array<ArrayBuffer>
let twoSeconds: Uint8Array<ArrayBuffer>
beforeAll(async () => {
  if (!hasFfmpeg) return
  tenSeconds = await toneFile(10)
  twoSeconds = await toneFile(2)
})

let iu: FakeIu
afterEach(() => iu?.stop())

const media = ffmpegMedia({ mp3BitrateKbps: 48, opusBitrateKbps: 32 })

function setup(
  transcriptions: (r: FakeRequest, attempt: number) => Response | Promise<Response>,
  opts: { config?: Partial<AudioConfig>; media?: MediaPort } = {},
) {
  iu = startFakeIu({ transcriptions })
  const deps = testDeps(iu, { media: opts.media ?? media, ...(opts.config && { config: opts.config }) })
  return { deps, transcribe: createTranscriptionsHandler(deps) }
}

function post(audio: Uint8Array<ArrayBuffer>, fields: Record<string, string> = {}, name = 'clip.wav') {
  const form = new FormData()
  form.append('file', new File([audio], name, { type: 'audio/wav' }))
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return new Request('http://door/v1/audio/transcriptions', { method: 'POST', body: form })
}

const calls = (events: UsageEvent[]) => events.filter((e): e is CallEvent => e.kind === 'call')
const summary = (events: UsageEvent[]) => events.find((e): e is RequestEvent => e.kind === 'request')
const fileName = (r: FakeRequest) => (r.form?.get('file') as File | null)?.name ?? ''
const sentModels = () => iu.requests.map((r) => r.form?.get('model'))
const voxtralBody = (text = 'Hallo Welt') =>
  Response.json({ model: VOXTRAL, text, language: null, segments: [], usage: { prompt_audio_seconds: 6 } })

describe.skipIf(!hasFfmpeg)('transcriptions door', () => {
  test('an empty-bodied upstream 5xx is a JSON error naming the model, after the fallback chain ran', async () => {
    const { deps, transcribe } = setup(() => new Response('', { status: 500 }))
    const res = await transcribe(post(twoSeconds))
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('upstream_error')
    expect(body.error.message).toBe(`upstream ${GPT_TRANSCRIBE} returned 500 with an empty body`)
    expect(sentModels()).toEqual([VOXTRAL, GPT_TRANSCRIBE])
    expect(calls(deps.usage.events).map((e) => e.costSource)).toEqual(['not-billed', 'not-billed'])
    expect(summary(deps.usage.events)).toMatchObject({ status: 500, model: GPT_TRANSCRIBE, requestedModel: '' })
  })

  test('the fallback chain: gpt-transcribe falls back to whisper; whisper is terminal; a 4xx never falls back', async () => {
    const { transcribe } = setup((r) =>
      r.form?.get('model') === WHISPER ? Response.json({ text: 'ok' }) : new Response('down', { status: 404 }),
    )
    expect((await transcribe(post(twoSeconds, { model: GPT_TRANSCRIBE }))).status).toBe(200)
    expect(sentModels()).toEqual([GPT_TRANSCRIBE, WHISPER])
    iu.on('transcriptions', () => new Response('bad', { status: 400 }))
    iu.requests.length = 0
    expect((await transcribe(post(twoSeconds))).status).toBe(400)
    expect(sentModels()).toEqual([VOXTRAL])
  })

  test('an unknown or OpenAI-only model is remapped to the default', async () => {
    const { deps, transcribe } = setup(() => voxtralBody())
    await transcribe(post(twoSeconds, { model: 'tts-1-hd-transcribe' }))
    expect(sentModels()).toEqual([VOXTRAL])
    expect(summary(deps.usage.events)?.requestedModel).toBe('tts-1-hd-transcribe')
  })

  test('per-minute models are priced from the probed duration, which wins over the reply seconds', async () => {
    for (const [model, perMinute] of [
      [VOXTRAL, 0.0035],
      [GPT_TRANSCRIBE, 0.0045],
      [WHISPER, 0.006],
    ] as const) {
      const { deps, transcribe } = setup(() => voxtralBody())
      expect((await transcribe(post(twoSeconds, { model }))).status).toBe(200)
      const [call] = calls(deps.usage.events)
      expect(call?.units).toBe('audio-seconds')
      expect(Math.abs((call?.quantity ?? 0) - 2)).toBeLessThan(0.2)
      expect(call?.costUsd).toBeCloseTo(((call?.quantity ?? 0) / 60) * perMinute, 12)
      expect(call?.priceVerified).toBe(false)
      iu.stop()
    }
  })

  test('a token-billed model is priced by its audio and output tokens', async () => {
    const { deps, transcribe } = setup(() =>
      Response.json({
        text: 'hi',
        usage: { input_tokens: 1000, output_tokens: 100, input_token_details: { audio_tokens: 1000 } },
      }),
    )
    await transcribe(post(twoSeconds, { model: GPT_4O }))
    expect(calls(deps.usage.events)[0]?.costUsd).toBeCloseTo((1000 * 6 + 100 * 10) / 1_000_000, 12)
  })

  test('voxtral JSON is synthesized into verbose_json with the requested language; upstream is asked for json', async () => {
    const { transcribe } = setup(() => voxtralBody())
    const res = await transcribe(post(twoSeconds, { response_format: 'verbose_json', language: 'de' }))
    expect(res.status).toBe(200)
    expect(iu.requests[0]?.form?.get('response_format')).toBe('json')
    const json = (await res.json()) as { text: string; task: string; language: string; duration: number }
    expect(json).toMatchObject({ text: 'Hallo Welt', task: 'transcribe', language: 'de' })
    expect(Math.abs(json.duration - 2)).toBeLessThan(0.2)
  })

  test('srt and vtt envelopes; text answers plain text, not the raw JSON', async () => {
    const { transcribe } = setup(() => voxtralBody())
    expect(await (await transcribe(post(twoSeconds, { response_format: 'srt' }))).text()).toMatch(
      /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nHallo Welt\n$/,
    )
    const vtt = await transcribe(post(twoSeconds, { response_format: 'vtt' }))
    expect(vtt.headers.get('content-type')).toContain('text/vtt')
    expect(await vtt.text()).toMatch(/^WEBVTT\n\n00:00:00\.000 --> /)
    const text = await transcribe(post(twoSeconds, { response_format: 'text' }))
    expect(text.headers.get('content-type')).toContain('text/plain')
    expect(await text.text()).toBe('Hallo Welt')
  })

  test('whisper rich formats pass through raw and untouched by prompt stripping', async () => {
    const raw = `1\n00:00:00,000 --> 00:00:02,000\n${PROMPT} Hallo\n`
    const { transcribe } = setup(() => new Response(raw, { headers: { 'content-type': 'text/plain' } }), {
      config: { sttPrompt: PROMPT },
    })
    const res = await transcribe(post(twoSeconds, { model: WHISPER, response_format: 'srt' }))
    expect(iu.requests[0]?.form?.get('response_format')).toBe('srt')
    expect(await res.text()).toBe(raw)
  })

  test('a verbatim echoed prompt is stripped from a json answer; the default prompt and language are injected', async () => {
    const { transcribe } = setup(() => voxtralBody(`${PROMPT} Hallo Welt.`), {
      config: { sttPrompt: PROMPT, sttLanguage: 'de' },
    })
    const res = await transcribe(post(twoSeconds))
    expect(await res.json()).toEqual({ text: 'Hallo Welt.' })
    expect(iu.requests[0]?.form?.get('prompt')).toBe(PROMPT)
    expect(iu.requests[0]?.form?.get('language')).toBe('de')
  })

  test('context_bias: a client value passes to voxtral, the default is injected, and other models never get it', async () => {
    const { transcribe } = setup(() => voxtralBody(), { config: { sttContextBias: 'Krumm,Hermes' } })
    await transcribe(post(twoSeconds, { context_bias: 'Agw' }))
    await transcribe(post(twoSeconds))
    await transcribe(post(twoSeconds, { model: WHISPER, context_bias: 'Agw' }))
    expect(iu.requests.map((r) => r.form?.get('context_bias') ?? null)).toEqual(['Agw', 'Krumm,Hermes', null])
  })

  describe('oversize uploads', () => {
    // A 10 s tone compresses to ~40 KB: an 18 KB limit forces three parts.
    const chunked = { sttMaxUploadBytes: 18_000 }

    test('parts are transcribed concurrently, joined in order, and verbose_json is synthesized over the original', async () => {
      const { deps, transcribe } = setup((r) => Response.json({ text: `part${/part(\d+)/.exec(fileName(r))?.[1]}` }), {
        config: chunked,
      })
      const res = await transcribe(post(tenSeconds, { response_format: 'verbose_json' }))
      expect(res.status).toBe(200)
      const n = iu.requests.length
      expect(n).toBeGreaterThan(1)
      for (const r of iu.requests) expect(r.form?.get('response_format')).toBe('json')
      const json = (await res.json()) as { text: string; duration: number }
      expect(json.text).toBe(Array.from({ length: n }, (_, i) => `part${i + 1}`).join(' '))
      expect(Math.abs(json.duration - 10)).toBeLessThan(1)
      // Each part is priced from its cut length when the reply carries no seconds; together they cover the clip.
      const priced = calls(deps.usage.events)
      expect(priced).toHaveLength(n)
      expect(Math.abs(priced.reduce((s, e) => s + (e.quantity ?? 0), 0) - 10)).toBeLessThan(1)
      expect(summary(deps.usage.events)).toMatchObject({ chunks: n, calls: n, unpricedCalls: 0 })
    })

    test('a part that hits an outage retries alone on the fallback; every call is one event', async () => {
      const { deps, transcribe } = setup(
        (r) => {
          const name = fileName(r)
          if (name.includes('part2') && r.form?.get('model') === GPT_4O) return new Response('busy', { status: 503 })
          return Response.json({ text: name })
        },
        { config: chunked },
      )
      const res = await transcribe(post(tenSeconds, { model: GPT_4O }))
      expect(res.status).toBe(200)
      const byPart = new Map<string, unknown[]>()
      for (const r of iu.requests) {
        const name = fileName(r)
        byPart.set(name, [...(byPart.get(name) ?? []), r.form?.get('model')])
      }
      for (const [name, models] of byPart) {
        expect(models).toEqual(name.includes('part2') ? [GPT_4O, GPT_TRANSCRIBE] : [GPT_4O])
      }
      expect(calls(deps.usage.events)).toHaveLength(iu.requests.length)
      expect(summary(deps.usage.events)?.model).toBe(GPT_TRANSCRIBE)
    })

    test('a part failing with a client error surfaces as is, without a fallback', async () => {
      const { transcribe } = setup(
        (r) =>
          fileName(r).includes('part2')
            ? new Response('unsupported codec', { status: 415 })
            : Response.json({ text: 'ok' }),
        { config: chunked },
      )
      const res = await transcribe(post(tenSeconds))
      expect(res.status).toBe(415)
      expect(await res.text()).toContain('unsupported codec')
    })

    test('a slice still over the limit is a 413 and nothing is sent upstream', async () => {
      const { transcribe } = setup(() => Response.json({ text: 'never' }), {
        config: chunked,
        media: { ...media, slice: async () => new ArrayBuffer(20_000) },
      })
      const res = await transcribe(post(tenSeconds))
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: { type: string; message: string } }
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.message).toContain('over the')
      expect(iu.requests).toHaveLength(0)
    })

    test('more chunks than allowed is a 413', async () => {
      const { transcribe } = setup(() => Response.json({ text: 'never' }), { config: { ...chunked, sttMaxChunks: 2 } })
      const res = await transcribe(post(tenSeconds))
      expect(res.status).toBe(413)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('2-chunk limit')
    })

    test('a broken ffmpeg sends the original upload unchanged', async () => {
      const { transcribe } = setup(() => Response.json({ text: 'ok' }), {
        config: { sttMaxUploadBytes: 1000 },
        media: {
          ...media,
          compressForStt: async () => {
            throw new Error('ffmpeg exploded')
          },
        },
      })
      const res = await transcribe(post(twoSeconds))
      expect(res.status).toBe(200)
      expect(fileName(iu.requests[0] as FakeRequest)).toBe('clip.wav')
    })

    test('an overlong clip under the byte limit is split on duration alone, at silence-snapped cuts', async () => {
      const { transcribe } = setup(() => Response.json({ text: 'x' }), { config: { sttMaxChunkSeconds: 4 } })
      expect((await transcribe(post(tenSeconds))).status).toBe(200)
      expect(iu.requests).toHaveLength(3)
    })
  })

  describe('billed means recorded', () => {
    test('a 2xx reply that is not readable JSON is recorded, answered 502 and never retried on the fallback', async () => {
      const { deps, transcribe } = setup(
        () => new Response('{"text": "cut', { headers: { 'content-type': 'application/json' } }),
      )
      const res = await transcribe(post(twoSeconds))
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe('upstream_error')
      expect(sentModels()).toEqual([VOXTRAL])
      const [call] = calls(deps.usage.events)
      expect(call).toMatchObject({ status: 200, costSource: 'rate' })
      expect(Math.abs((call?.quantity ?? 0) - 2)).toBeLessThan(0.2)
    })

    test('an unreadable part fails the joined request as 502 after recording it', async () => {
      const { deps, transcribe } = setup(
        (r) =>
          fileName(r).includes('part2')
            ? new Response('garbage', { headers: { 'content-type': 'application/json' } })
            : Response.json({ text: 'ok' }),
        { config: { sttMaxUploadBytes: 18_000 } },
      )
      expect((await transcribe(post(tenSeconds))).status).toBe(502)
      expect(calls(deps.usage.events)).toHaveLength(iu.requests.length)
    })

    test('a failed probe (0 s) is no measurement: the reply seconds price it, else the cost is unknown', async () => {
      const blind = { ...media, duration: async () => 0 }
      const { deps, transcribe } = setup(() => voxtralBody(), { media: blind })
      await transcribe(post(twoSeconds))
      expect(calls(deps.usage.events)[0]).toMatchObject({ quantity: 6, costSource: 'rate' })
      iu.stop()
      const second = setup(() => Response.json({ text: 'x' }), { media: blind })
      await second.transcribe(post(twoSeconds))
      expect(calls(second.deps.usage.events)[0]).toMatchObject({ costUsd: null, costSource: 'unknown' })
    })

    test('envelope synthesis reuses the measured duration instead of probing the upload again', async () => {
      let probes = 0
      const counting = {
        ...media,
        duration: (data: Blob | ArrayBuffer | Uint8Array) => {
          probes++
          return media.duration(data)
        },
      }
      const { transcribe } = setup(() => voxtralBody(), { media: counting })
      const res = await transcribe(post(twoSeconds, { response_format: 'verbose_json' }))
      expect(Math.abs(((await res.json()) as { duration: number }).duration - 2)).toBeLessThan(0.2)
      expect(probes).toBe(1)
    })
  })
})
