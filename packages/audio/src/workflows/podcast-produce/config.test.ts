import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { audioRoutes } from '../../routes.ts'
import { DEFAULT_TTS_ROUTE, produceConfigFromEnv, ttsRouteFor } from './config.ts'

describe('produceConfigFromEnv', () => {
  test("legacy's defaults with an empty env; publish and the Slack notice are off", () => {
    const config = produceConfigFromEnv({})
    expect(config).toMatchObject({
      ttsRouteId: DEFAULT_TTS_ROUTE,
      hostStyles: ['warm, conversational', 'warm, conversational'],
      multiSpeakerMaxChars: 3000,
      stability: 0.5,
      denseTurnThreshold: 0.12,
      denseTurnSlowdown: 0.06,
      bitrateKbps: 64,
      gapMs: 380,
      shortGapMs: 160,
      author: 'Hermes',
      abs: null,
      notify: null,
    })
  })

  test('ABS needs url and key; the url gains a scheme and loses its trailing slash; the library defaults', () => {
    expect(produceConfigFromEnv({ ABS_URL: 'https://abs.example.com' }).abs).toBeNull()
    expect(produceConfigFromEnv({ ABS_URL: 'abs.example.com/', ABS_API_KEY: 'k' }).abs).toEqual({
      url: 'https://abs.example.com',
      apiKey: 'k',
      library: 'Podcasts',
    })
    expect(produceConfigFromEnv({ ABS_URL: 'http://abs', ABS_API_KEY: 'k', ABS_LIBRARY: 'Shows' }).abs?.library).toBe(
      'Shows',
    )
  })

  test('the vault defaults to ~/SourceRoot/brain when AGW_BRAIN_DIR is unset or blank', () => {
    const expected = join(homedir(), 'SourceRoot', 'brain')
    expect(produceConfigFromEnv({}).brainDir).toBe(expected)
    expect(produceConfigFromEnv({ AGW_BRAIN_DIR: '  ' }).brainDir).toBe(expected)
  })

  test('AGW_BRAIN_DIR wins, trimmed, without a trailing slash, absolute; the old BRAIN_DIR is ignored', () => {
    expect(produceConfigFromEnv({ AGW_BRAIN_DIR: ' /srv/vault/ ', BRAIN_DIR: '/old' }).brainDir).toBe('/srv/vault')
    const relative = produceConfigFromEnv({ AGW_BRAIN_DIR: 'vault/' }).brainDir
    expect(relative.startsWith('/')).toBe(true)
    expect(relative.endsWith('/vault')).toBe(true)
  })

  test('a malformed number fails loudly, naming the variable', () => {
    expect(() => produceConfigFromEnv({ PODCAST_GAP_MS: 'soon' })).toThrow('PODCAST_GAP_MS')
  })
})

describe('ttsRouteFor', () => {
  test('a route id as is, a model id through the table, both lanes', () => {
    expect(ttsRouteFor('audio.tts.elevenlabs-v3', {})).toBe('audio.tts.elevenlabs-v3')
    expect(ttsRouteFor(audioRoutes({})['audio.tts.elevenlabs-v3'].model, {})).toBe('audio.tts.elevenlabs-v3')
  })

  test('anything else, or a route that is not a TTS lane, is refused', () => {
    expect(() => ttsRouteFor('no-such-model', {})).toThrow('PODCAST_TTS_MODEL')
    expect(() => ttsRouteFor('audio.tts.prep', {})).toThrow('PODCAST_TTS_MODEL')
  })
})
