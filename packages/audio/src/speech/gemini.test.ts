import { afterEach, describe, expect, test } from 'bun:test'
import { createSpeechHandler } from '../door/speech.ts'
import { audioRoutes } from '../routes.ts'

const ROUTES = audioRoutes()
import { createAudioScope } from '../scope.ts'
import {
  audioEvent,
  caught,
  type FakeIu,
  geminiAudio,
  prepAnswer,
  startFakeIu,
  streamBody,
  testDeps,
} from '../testing/index.ts'
import type { CallEvent, RequestEvent, UsageEvent } from '../usage.ts'
import { DELIVERY_STYLES } from './core.ts'
import { multiSpeakerBody, sseAudio, stripWavHeader, synthBody, synthMultiSpeaker } from './gemini.ts'
import { PREP_STYLE } from './prep.ts'

const LITE = ROUTES['audio.tts.gemini-flash-lite'].model
const FLASH = ROUTES['audio.tts.gemini-flash'].model

let iu: FakeIu
afterEach(() => iu?.stop())

/** A fake media port: transcode returns the PCM as is (tagged), so lane tests need no ffmpeg. */
const passMedia = {
  transcode: async (input: Uint8Array, _from: unknown, to: string) => ({
    bytes: input.slice().buffer,
    contentType: to === 'mp3' ? 'audio/mpeg' : `audio/${to}`,
  }),
  duration: async () => 0,
  compressForStt: async () => new ArrayBuffer(0),
  slice: async () => new ArrayBuffer(0),
  detectSilence: async () => [],
}

function setup(handlers: Parameters<typeof startFakeIu>[0] = {}, config = {}) {
  iu = startFakeIu(handlers)
  const deps = testDeps(iu, { media: passMedia, config })
  return { deps, speak: createSpeechHandler(deps) }
}

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://door/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const calls = (events: UsageEvent[]) => events.filter((e): e is CallEvent => e.kind === 'call')
const summaries = (events: UsageEvent[]) => events.filter((e): e is RequestEvent => e.kind === 'request')
const sentText = (r: { json: Record<string, unknown> | null }) =>
  (r.json as { contents: Array<{ parts: Array<{ text: string; speechMetadata?: { style?: string } }> }> }).contents[0]
    ?.parts[0]

describe('synthBody: 3.8 request shape', () => {
  test('style travels in parts[].speechMetadata, never as a spoken prefix', () => {
    const body = synthBody('Charon', { style: 'calm', text: 'Hallo.' }, { rawPcm: true }) as {
      contents: Array<{ parts: Array<{ text: string; speechMetadata: { style: string } }> }>
      generationConfig: Record<string, unknown>
    }
    expect(body.contents[0]?.parts[0]).toEqual({ text: 'Hallo.', speechMetadata: { style: 'calm' } })
    expect(body.generationConfig.responseFormat).toEqual({ audio: { mimeType: 'AUDIO_L16' } })
    expect(JSON.stringify(body)).not.toContain('systemInstruction')
  })

  test('an empty style omits speechMetadata; the stream body omits responseFormat', () => {
    const body = synthBody('Kore', { style: '', text: 'Hi.' }, { rawPcm: false }) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
      generationConfig: Record<string, unknown>
    }
    expect(body.contents[0]?.parts[0]).toEqual({ text: 'Hi.' })
    expect(body.generationConfig.responseFormat).toBeUndefined()
  })
})

describe('sseAudio', () => {
  test('extracts base64 PCM, ignores events without audio, throws on garbled and error events', () => {
    expect([...(sseAudio(audioEvent([1, 2]).slice(6).trim()) ?? [])]).toEqual([1, 2])
    expect(sseAudio(JSON.stringify({ usageMetadata: {} }))).toBeNull()
    expect(() => sseAudio('{"cand')).toThrow(/unparseable/)
    expect(() => sseAudio(JSON.stringify({ error: { message: 'quota' } }))).toThrow(/quota/)
  })
})

/** A RIFF/WAVE: fmt, data, then a trailing C2PA chunk like 3.8 unary WAVs carry. */
function wavWithTrailer(pcm: Uint8Array, trailer: Uint8Array): Uint8Array {
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length % 2))
    out.set(new TextEncoder().encode(id), 0)
    new DataView(out.buffer).setUint32(4, body.length, true)
    out.set(body, 8)
    return out
  }
  const parts = [chunk('fmt ', new Uint8Array(16)), chunk('data', pcm), chunk('C2PA', trailer)]
  const size = 4 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(8 + size)
  out.set(new TextEncoder().encode('RIFF'), 0)
  new DataView(out.buffer).setUint32(4, size, true)
  out.set(new TextEncoder().encode('WAVE'), 8)
  let at = 12
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

describe('stripWavHeader: C2PA trailing chunk', () => {
  test('returns only the data chunk, dropping the header and the trailing C2PA bytes', () => {
    const pcm = Uint8Array.from({ length: 101 }, (_, i) => i + 1)
    expect([...stripWavHeader(wavWithTrailer(pcm, new Uint8Array(6000).fill(0xff)))]).toEqual([...pcm])
  })
  test('raw PCM passes through untouched', () => {
    const pcm = Uint8Array.from([1, 2, 3, 4])
    expect(stripWavHeader(pcm)).toBe(pcm)
  })
  test('a RIFF/WAVE without a data chunk throws instead of playing garbage', () => {
    const wav = wavWithTrailer(new Uint8Array(0), new Uint8Array(4))
    wav.set(new TextEncoder().encode('xxxx'), 12 + 24)
    expect(() => stripWavHeader(wav)).toThrow(/no data chunk/)
  })
})

describe('multi-speaker (podcast production stage)', () => {
  const voices = [
    { speaker: 'Anna', voiceName: 'Erinome' },
    { speaker: 'Ben', voiceName: 'Charon' },
  ] as [{ speaker: string; voiceName: string }, { speaker: string; voiceName: string }]

  test('one part per turn with speechMetadata.speaker, both voices configured, raw L16 asked', () => {
    const body = multiSpeakerBody(voices, [
      { speaker: 'Anna', text: 'Hallo?', style: 'curious, leaning in' },
      { speaker: 'Ben', text: 'Ja.' },
    ]) as {
      contents: Array<{ parts: unknown[] }>
      generationConfig: {
        responseFormat: unknown
        speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: unknown[] } }
      }
    }
    expect(body.contents[0]?.parts).toEqual([
      { text: 'Hallo?', speechMetadata: { speaker: 'Anna', style: 'curious, leaning in' } },
      { text: 'Ja.', speechMetadata: { speaker: 'Ben' } },
    ])
    expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2)
    expect(body.generationConfig.responseFormat).toEqual({ audio: { mimeType: 'AUDIO_L16' } })
  })

  test('synthMultiSpeaker posts one generateContent call, returns the PCM and records one priced call', async () => {
    iu = startFakeIu({
      gemini: () => geminiAudio(new Uint8Array(4800), { promptTokenCount: 20, candidatesTokenCount: 25 }),
    })
    const deps = testDeps(iu)
    const scope = createAudioScope(deps, { requestId: 'job-1', caller: 'podcast' })
    const audio = await synthMultiSpeaker(scope, {
      routeId: 'audio.tts.gemini-flash',
      voices,
      parts: [{ speaker: 'Anna', text: 'Hallo.' }],
    })
    expect(audio.pcm.byteLength).toBe(4800)
    expect(audio.sampleRate).toBe(24_000)
    expect(iu.requests[0]?.path).toBe(`/gemini/v1beta/models/${FLASH}:generateContent`)
    const [event] = calls(deps.usage.events)
    expect(event).toMatchObject({
      requestId: 'job-1',
      caller: 'podcast',
      routeId: 'audio.tts.gemini-flash',
      units: 'tokens',
    })
    expect(event?.costUsd).toBeCloseTo((20 * 0.5 + 25 * 9) / 1_000_000, 12)
  })
})

describe('chat lane (no prep)', () => {
  test('one raw generateContent call, markdown and units cleaned, no LLM call, title header from the input', async () => {
    const { deps, speak } = setup({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    const res = await speak(post({ model: LITE, input: '**Heute** wird es 22°C warm ☀️', voice: 'Charon' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(decodeURIComponent(res.headers.get('x-audio-title') ?? '')).toBe('**Heute** wird es 22°C warm ☀️')
    expect(iu.requests.map((r) => r.route)).toEqual(['gemini'])
    expect(sentText(iu.requests[0] ?? { json: null })?.text).toBe('Heute wird es 22 Grad warm')
    const [summary] = summaries(deps.usage.events)
    expect(summary).toMatchObject({
      mode: 'direct',
      lane: 'gemini',
      chunks: 1,
      status: 200,
      calls: 1,
      costSource: 'rate',
    })
  })

  test('allowlisted inline tags pass through, invented ones are stripped', async () => {
    const { speak } = setup({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    await speak(post({ model: LITE, input: 'Na ja <sigh> das war <excited> knapp.' }))
    expect(sentText(iu.requests[0] ?? { json: null })?.text).toBe('Na ja <sigh> das war knapp.')
  })

  test('a caller delivery key becomes the request style; a string `style` means the same', async () => {
    const { speak } = setup({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) })
    await speak(post({ model: LITE, input: 'Hallo.', delivery: 'Serious' }))
    await speak(post({ model: LITE, input: 'Hallo.', style: 'dry' }))
    expect(sentText(iu.requests[0] ?? { json: null })?.speechMetadata?.style).toBe(DELIVERY_STYLES.serious)
    expect(sentText(iu.requests[1] ?? { json: null })?.speechMetadata?.style).toBe(DELIVERY_STYLES.dry)
  })

  test('a delivery outside the vocabulary is a 400 before any upstream call', async () => {
    const { speak } = setup()
    const res = await speak(post({ model: LITE, input: 'Hallo.', delivery: 'furious' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('unsupported delivery')
    expect(iu.requests).toHaveLength(0)
  })
})

describe('briefing lane (prep)', () => {
  test('prep runs for the prep model: delivery keys map to styles, the rest keep the baseline, invented tags go', async () => {
    const { deps, speak } = setup({
      chat: () =>
        prepAnswer({
          lang: 'de',
          title: 'Wetter morgen',
          chunks: [{ delivery: 'serious', text: 'Morgen <short pause> Sturm.' }, { text: 'Danach <excited> Sonne.' }],
        }),
      gemini: () => geminiAudio(Uint8Array.from([1, 0])),
    })
    const res = await speak(post({ model: FLASH, input: 'Morgen Sturm, danach Sonne.' }))
    expect(res.status).toBe(200)
    expect(decodeURIComponent(res.headers.get('x-audio-title') ?? '')).toBe('Wetter morgen')
    const chat = iu.requests.find((r) => r.route === 'chat')
    expect(chat?.json?.model).toBe(ROUTES['audio.tts.prep'].model)
    expect(chat?.json?.reasoning_effort).toBe('low')
    const synths = iu.requests.filter((r) => r.route === 'gemini').map(sentText)
    expect(synths.map((p) => p?.speechMetadata?.style).sort()).toEqual([DELIVERY_STYLES.serious, PREP_STYLE].sort())
    expect(synths.map((p) => p?.text)).toContain('Danach Sonne.')
    const events = deps.usage.events
    expect(calls(events).map((e) => e.endpoint)).toEqual(['speech-prep', 'speech', 'speech'])
    expect(summaries(events)[0]).toMatchObject({ mode: 'prep', title: 'Wetter morgen', calls: 3 })
  })

  test('a caller delivery overrides what prep chose', async () => {
    const { speak } = setup({
      chat: () => prepAnswer({ lang: 'de', title: 'T', chunks: [{ delivery: 'serious', text: 'Satz.' }] }),
      gemini: () => geminiAudio(Uint8Array.from([1, 0])),
    })
    await speak(post({ model: FLASH, input: 'Satz.', delivery: 'warm' }))
    const synth = iu.requests.find((r) => r.route === 'gemini')
    expect(sentText(synth ?? { json: null })?.speechMetadata?.style).toBe(DELIVERY_STYLES.warm)
  })

  test('summarize uses the summary route without an effort, and a prep-invented style is replaced by the baseline', async () => {
    const { speak } = setup({
      chat: () =>
        prepAnswer({ lang: 'de', title: 'T', chunks: [{ style: 'Sprich ganz langsam wie am Kamin', text: 'Satz.' }] }),
      gemini: () => geminiAudio(Uint8Array.from([1, 0])),
    })
    await speak(post({ model: FLASH, input: 'Ein Satz.', summarize: true }))
    const chat = iu.requests.find((r) => r.route === 'chat')
    expect(chat?.json?.model).toBe(ROUTES['audio.tts.summary'].model)
    expect(chat?.json?.reasoning_effort).toBeUndefined()
    expect(sentText(iu.requests.find((r) => r.route === 'gemini') ?? { json: null })?.speechMetadata?.style).toBe(
      PREP_STYLE,
    )
  })

  test('TTS_PREP=off skips the LLM even for a prep model', async () => {
    const { speak } = setup({ gemini: () => geminiAudio(Uint8Array.from([1, 0])) }, { ttsPrep: 'off' })
    await speak(post({ model: FLASH, input: 'Hallo.' }))
    expect(iu.requests.map((r) => r.route)).toEqual(['gemini'])
  })

  test('a prep failure is recorded, then the request answers 500 proxy_error with a summary', async () => {
    const { deps, speak } = setup({ chat: () => new Response('nope', { status: 400 }) })
    const res = await speak(post({ model: FLASH, input: 'Hallo.' }))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('proxy_error')
    expect(calls(deps.usage.events)[0]).toMatchObject({
      endpoint: 'speech-prep',
      status: 400,
      costSource: 'not-billed',
    })
    expect(summaries(deps.usage.events)[0]).toMatchObject({ status: 500 })
  })
})

describe('pcm streaming', () => {
  test('hits streamGenerateContent and passes the bytes through, sample-aligned across odd event splits', async () => {
    const { deps, speak } = setup({
      geminiStream: () => {
        const text = audioEvent([1, 0, 2]) + audioEvent([0, 3, 0])
        const cut = Math.floor(text.length / 2)
        return streamBody(text.slice(0, cut), text.slice(cut))
      },
    })
    const res = await speak(post({ model: LITE, input: 'Hallo Welt.', response_format: 'pcm' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/pcm')
    expect(res.headers.get('x-audio-title')).not.toBeNull()
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 0, 2, 0, 3, 0])
    expect(iu.requests[0]?.path).toBe(`/gemini/v1beta/models/${LITE}:streamGenerateContent`)
    await deps.usage.settledSummary()
    const [call] = calls(deps.usage.events)
    // Streamed usageMetadata is wrong: billed from duration at 25 tokens/s.
    expect(call?.outputTokens).toBe(Math.round((6 / 48_000) * 25))
    expect(summaries(deps.usage.events)[0]).toMatchObject({ status: 200, bytesOut: 6 })
  })

  test('an upstream error before the first byte is a normal HTTP error, not a 200 stream', async () => {
    const { deps, speak } = setup({ geminiStream: () => new Response('boom', { status: 500 }) })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('HTTP 500')
    expect(summaries(deps.usage.events)[0]).toMatchObject({ status: 500 })
  })

  test('an in-band error event after audio aborts the body and the summary carries the failure', async () => {
    const { deps, speak } = setup({
      geminiStream: () =>
        streamBody(audioEvent([1, 0]), `data: ${JSON.stringify({ error: { message: 'quota' } })}\n\n`),
    })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    expect(res.status).toBe(200)
    await caught(res.arrayBuffer())
    const summary = await deps.usage.settledSummary()
    expect(summary).toMatchObject({ status: 500 })
    expect(summary.errorText).toContain('quota')
  })

  test('a malformed trailing event fails the stream instead of ending it short', async () => {
    const { deps, speak } = setup({ geminiStream: () => streamBody(audioEvent([1, 0]), 'data: {"candidates":[{"cont') })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    await caught(res.arrayBuffer())
    expect((await deps.usage.settledSummary()).errorText).toContain('unparseable')
  })

  test('a stream with no audio events fails before the first byte', async () => {
    const { speak } = setup({
      geminiStream: () => streamBody(`data: ${JSON.stringify({ usageMetadata: { candidatesTokenCount: 1 } })}\n\n`),
    })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('no audio')
  })

  test('a 503 before the first byte is retried', async () => {
    const { speak } = setup({
      geminiStream: (_r, attempt) =>
        attempt === 1 ? new Response('busy', { status: 503 }) : streamBody(audioEvent([5, 0])),
    })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([5, 0])
    expect(iu.requests).toHaveLength(2)
  })

  test('multi-chunk pcm joins chunks with 400 ms of silence, none before the first', async () => {
    const sentence = `${Array.from({ length: 140 }, () => 'wort').join(' ')}.`
    const { deps, speak } = setup({ geminiStream: () => streamBody(audioEvent([7, 0])) })
    const res = await speak(post({ model: LITE, input: `${sentence} ${sentence}`, response_format: 'pcm' }))
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(iu.requests).toHaveLength(2)
    expect(bytes.byteLength).toBe(2 + 19_200 + 2)
    expect(bytes[0]).toBe(7)
    expect(bytes[2]).toBe(0)
    expect(bytes[bytes.byteLength - 2]).toBe(7)
    expect((await deps.usage.settledSummary()).chunks).toBe(2)
  })

  test('cancelling the body stops further chunk requests and settles cleanly', async () => {
    const sentence = `${Array.from({ length: 140 }, () => 'wort').join(' ')}.`
    const { deps, speak } = setup({ geminiStream: () => streamBody(audioEvent([1, 0])) })
    const res = await speak(post({ model: LITE, input: `${sentence} ${sentence} ${sentence}`, response_format: 'pcm' }))
    await res.body?.cancel()
    await deps.usage.settledSummary()
    expect(iu.requests.length).toBeLessThan(3)
  })

  test('the first byte never waits on the usage port', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    iu = startFakeIu({ geminiStream: () => streamBody(audioEvent([9, 0])) })
    const recorded: UsageEvent[] = []
    const deps = {
      ...testDeps(iu),
      usage: {
        record: async (event: UsageEvent) => {
          await gate
          recorded.push(event)
        },
      },
    }
    const res = await createSpeechHandler(deps)(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 0])
    expect(recorded).toHaveLength(0)
    release()
  })

  test('non-pcm formats keep the whole-file generateContent path', async () => {
    const { speak } = setup({ gemini: () => geminiAudio(new Uint8Array(4800)) })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'wav' }))
    expect(res.status).toBe(200)
    expect(iu.requests.map((r) => r.route)).toEqual(['gemini'])
  })
})

describe('billing and audio integrity', () => {
  test('a 2xx without audio records its usageMetadata (the prompt is billed) and fails', async () => {
    const { deps, speak } = setup({
      gemini: () => Response.json({ candidates: [], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 0 } }),
    })
    expect((await speak(post({ model: LITE, input: 'Hallo.' }))).status).toBe(500)
    const [call] = calls(deps.usage.events)
    expect(call).toMatchObject({ status: 200, inputTokens: 40, costSource: 'rate' })
    expect(call?.costUsd).toBeCloseTo((40 * 0.5) / 1e6, 12)
  })

  test('an odd unary byte count is trimmed to whole samples, so later chunks stay aligned', async () => {
    const sentence = `${Array.from({ length: 140 }, () => 'wort').join(' ')}.`
    const { speak } = setup({ gemini: () => geminiAudio(Uint8Array.from([1, 0, 9])) })
    const res = await speak(post({ model: LITE, input: `${sentence} ${sentence}`, response_format: 'wav' }))
    // passMedia returns the joined PCM: 2 + 19,200 silence + 2, the stray byte gone.
    expect((await res.arrayBuffer()).byteLength).toBe(2 + 19_200 + 2)
  })

  test('a streamed call carries the prompt tokens it reported, once', async () => {
    const usage = `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1 } })}\n\n`
    const { deps, speak } = setup({ geminiStream: () => streamBody(audioEvent([1, 0]), usage) })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    await res.arrayBuffer()
    await deps.usage.settledSummary()
    expect(calls(deps.usage.events)).toEqual([expect.objectContaining({ inputTokens: 12, outputTokens: 0 })])
  })

  test('a client that cancels a pcm stream aborts the upstream read', async () => {
    let aborted!: () => void
    const upstreamAborted = new Promise<void>((resolve) => {
      aborted = resolve
    })
    const { deps, speak } = setup({
      geminiStream: (r) => {
        r.signal.addEventListener('abort', () => aborted(), { once: true })
        // One event, then an upstream that keeps the stream open (still "generating").
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(audioEvent([3, 0])))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const res = await speak(post({ model: LITE, input: 'Hallo.', response_format: 'pcm' }))
    const reader = res.body?.getReader()
    await reader?.read()
    await reader?.cancel()
    await upstreamAborted
    const summary = await deps.usage.settledSummary()
    expect(summary.status).toBe(200)
    expect(calls(deps.usage.events)[0]?.errorText).toContain('client cancelled')
  })
})
