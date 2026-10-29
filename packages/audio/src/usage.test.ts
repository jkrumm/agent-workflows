import { describe, expect, test } from 'bun:test'
import { AudioConfigError, audioConfig, audioTransports } from './config.ts'
import { type AudioRouteId, audioRoutes } from './routes.ts'

const ROUTES = audioRoutes()
import { measureFromOpenAiUsage, priceCall } from './usage.ts'

const route = (id: AudioRouteId) => ROUTES[id]

describe('priceCall (legacy computeCost rates)', () => {
  test('Gemini TTS: input and audio-output tokens', () => {
    const p = priceCall(route('audio.tts.gemini-flash'), 200, { inputTokens: 100, outputTokens: 2500 })
    expect(p).toMatchObject({ units: 'tokens', quantity: 2600, costSource: 'rate', priceVerified: false })
    expect(p.costUsd).toBeCloseTo((100 * 0.5 + 2500 * 9) / 1e6, 12)
  })

  test('ElevenLabs per 1k characters; a missing count is unknown, never 0', () => {
    expect(priceCall(route('audio.tts.elevenlabs-v3'), 200, { inputChars: 2000 }).costUsd).toBeCloseTo(0.2, 12)
    expect(priceCall(route('audio.tts.elevenlabs-flash'), 200, {})).toMatchObject({
      costUsd: null,
      costSource: 'unknown',
    })
  })

  test('STT per minute; token STT bills the audio share at the audio rate (all input when the split is missing)', () => {
    expect(priceCall(route('audio.stt.openai-legacy'), 200, { audioSeconds: 90 }).costUsd).toBeCloseTo(0.009, 12)
    expect(priceCall(route('audio.stt.voxtral-mini'), 200, {})).toMatchObject({ costSource: 'unknown' })
    const mini = priceCall(route('audio.stt.openai-4o-mini'), 200, { inputTokens: 1000, outputTokens: 10 })
    expect(mini.costUsd).toBeCloseTo((1000 * 1.25 + 10 * 5) / 1e6, 12)
    expect(mini.priceVerified).toBe(true)
  })

  test('prep: cached share at the cached rate; the provider cost wins where sent', () => {
    const prep = route('audio.tts.prep')
    expect(priceCall(prep, 200, { inputTokens: 1000, cachedTokens: 400, outputTokens: 100 }).costUsd).toBeCloseTo(
      (600 * 0.1 + 400 * 0.01 + 100 * 0.5) / 1e6,
      12,
    )
    expect(priceCall(prep, 200, { inputTokens: 1, outputTokens: 1, providerCostUsd: 0.5 })).toMatchObject({
      costUsd: 0.5,
      costSource: 'provider',
    })
  })

  test('a failed call is not billed; a route without a price is unknown', () => {
    expect(priceCall(route('audio.tts.gemini-flash'), 503, { outputTokens: 99 })).toMatchObject({
      costUsd: 0,
      costSource: 'not-billed',
    })
    expect(
      priceCall({ id: 'audio.tts.prep', lane: 'llm', wire: 'iu-openai', model: 'm' }, 200, { inputChars: 5 }),
    ).toMatchObject({
      costUsd: null,
      costSource: 'unknown',
    })
  })

  test('measureFromOpenAiUsage reads chat, Voxtral and duration-typed usage', () => {
    expect(
      measureFromOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedTokens: 2 })
    expect(measureFromOpenAiUsage({ prompt_audio_seconds: 6 }).audioSeconds).toBe(6)
    expect(measureFromOpenAiUsage({ type: 'duration', seconds: 240 }).audioSeconds).toBe(240)
  })
})

describe('config', () => {
  test('every base derives from IU_BASE_URL; the key and a /anthropic base are required', () => {
    expect(audioTransports({ IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com/x/anthropic/' })).toEqual({
      apiKey: 'k',
      openaiBase: 'https://iu.example.com/x/openai/v1',
      geminiBase: 'https://iu.example.com/x/gemini/v1beta',
      replicateBase: 'https://iu.example.com/x/replicate/v1',
    })
    expect(() => audioTransports({ IU_BASE_URL: 'https://iu.example.com/anthropic' })).toThrow(AudioConfigError)
    expect(() => audioTransports({ IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com/openai/v1' })).toThrow(
      /must end in \/anthropic/,
    )
  })

  test('legacy env names and defaults; prep models default to the routes flagged prep', () => {
    const env = { IU_API_KEY: 'k', IU_BASE_URL: 'https://iu.example.com/anthropic' }
    const config = audioConfig(env)
    expect(config.ttsGeminiPrepModels).toEqual([ROUTES['audio.tts.gemini-flash'].model])
    expect(config.ttsReplicatePrepModels).toEqual([ROUTES['audio.tts.elevenlabs-v3'].model])
    expect(config.sttMaxChunkSeconds).toBe(240)
    const tuned = audioConfig({ ...env, STT_PROMPT: 'p', TTS_CONCURRENCY: '20', TTS_GEMINI_PREP_MODELS: 'a, b' })
    expect(tuned).toMatchObject({ sttPrompt: 'p', ttsConcurrency: 8, ttsGeminiPrepModels: ['a', 'b'] })
    for (const [raw, n] of [
      ['0', 1],
      ['-3', 1],
      ['2.7', 2],
      ['99', 8],
    ] as const) {
      expect(audioConfig({ ...env, STT_CHUNK_CONCURRENCY: raw, TTS_CONCURRENCY: raw })).toMatchObject({
        sttChunkConcurrency: n,
        ttsConcurrency: n,
      })
    }
    expect(() => audioConfig({ ...env, STT_MAX_CHUNKS: 'many' })).toThrow(/STT_MAX_CHUNKS/)
    expect(() => audioConfig({ ...env, TTS_PREP: 'sometimes' })).toThrow(/TTS_PREP/)
  })

  test('every STT fallback is an STT route', () => {
    for (const r of Object.values(ROUTES)) {
      if (r.sttFallback) expect(ROUTES[r.sttFallback as AudioRouteId]?.lane).toBe('stt')
    }
  })
})
