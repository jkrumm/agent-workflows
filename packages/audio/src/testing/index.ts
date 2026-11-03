// Audio's own test support: deps with an instant clock, a silent log, an in-process media port and a recording usage port,
// built on the lanes' ports, so the production lanes run against the fake gateway (@agent-workflows/testing/gateway) over HTTP.
import type { FakeGateway } from '@agent-workflows/testing/gateway'
import { type AudioConfig, audioConfig } from '../config.ts'
import { ffmpegMedia, type MediaPort } from '../media/audio.ts'
import type { AudioDeps, AudioLog, Clock, Fetch } from '../scope.ts'
import type { RequestEvent, UsageEvent, UsagePort } from '../usage.ts'

/**
 * The default media port of `testDeps`: in-process, no ffmpeg. `transcode` hands the input back labelled with the asked
 * format, `duration` is unknown (0). A test that exercises the real boundary passes `ffmpegMedia(...)` and skips on
 * `!hasFfmpeg`, so no test depends on the host having ffmpeg by accident.
 */
export const fakeMedia: MediaPort = {
  transcode: async (input, _from, to) => ({
    bytes: input.slice().buffer,
    contentType: to === 'mp3' ? 'audio/mpeg' : to === 'opus' ? 'audio/ogg' : `audio/${to}`,
  }),
  duration: async () => 0,
  compressForStt: async () => new ArrayBuffer(0),
  slice: async () => new ArrayBuffer(0),
  detectSilence: async () => [],
}

/** The real boundary, for the tests that exercise it (each skips on `!hasFfmpeg`). */
export const realMedia = (): MediaPort => ffmpegMedia({ mp3BitrateKbps: 48, opusBitrateKbps: 32 })

export const instantClock: Clock = { now: () => Date.now(), sleep: async () => {} }

export const silentLog: AudioLog = { info: () => {}, warn: () => {}, error: () => {} }

export interface RecordingUsage extends UsagePort {
  events: UsageEvent[]
  /** Resolves with the first request summary once it is recorded (a pcm stream records it when the body ends). */
  settledSummary(): Promise<RequestEvent>
}

export function recordingUsage(): RecordingUsage {
  const events: UsageEvent[] = []
  let resolveSummary!: (event: RequestEvent) => void
  const summary = new Promise<RequestEvent>((resolve) => {
    resolveSummary = resolve
  })
  return {
    events,
    record: (event) => {
      events.push(event)
      if (event.kind === 'request') resolveSummary(event)
    },
    settledSummary: () => summary,
  }
}

/** The token every fake-gateway test sends; the fake never checks it, tests assert the header. */
export const TEST_TOKEN = 'test-secret'

/** The env that points the lanes at the gateway at `url`. */
export const gatewayEnv = (url: string): Record<string, string> => ({
  AGW_GATEWAY_URL: url,
  AGW_API_SECRET: TEST_TOKEN,
})

/** A config from the defaults, on the fake's origin, with overrides. */
export function testConfig(url: string, overrides: Partial<AudioConfig> = {}): AudioConfig {
  return { ...audioConfig(gatewayEnv(url)), ...overrides }
}

export function testDeps(
  iu: FakeGateway,
  overrides: Partial<Omit<AudioDeps, 'config' | 'usage'>> & { config?: Partial<AudioConfig> } = {},
): AudioDeps & { usage: RecordingUsage } {
  const { config, ...rest } = overrides
  return {
    clock: instantClock,
    log: silentLog,
    fetch: iu.fetch,
    media: fakeMedia,
    ...rest,
    config: testConfig(iu.url, config),
    usage: recordingUsage(),
  }
}

/** The rejection of `promise` (fails the test when it resolves). */
export async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected a rejection')
}

export const hasFfmpeg = Boolean(Bun.which('ffmpeg')) && Boolean(Bun.which('ffprobe'))

/** `seconds` of a sine tone as a file in `format` (wav, mp3), via ffmpeg. */
export async function toneFile(
  seconds: number,
  opts: { format?: 'wav' | 'mp3' } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const format = opts.format ?? 'wav'
  const proc = Bun.spawn(
    [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=16000:duration=${seconds}`,
      '-ac',
      '1',
      ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '32k'] : []),
      '-f',
      format,
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [bytes, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
  if (code !== 0) throw new Error(`ffmpeg tone failed (${code})`)
  return new Uint8Array(bytes)
}
