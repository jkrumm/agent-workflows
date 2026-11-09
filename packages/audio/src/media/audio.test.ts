import { describe, expect, test } from 'bun:test'
import { caught, hasFfmpeg, toneFile } from '../../test/support.ts'
import {
  concatPcm,
  ffmpegMedia,
  ffmpegTimeoutMs,
  parseOutputFormat,
  parseSilence,
  pcmToWav,
  runGuarded,
  silencePcm,
} from './audio.ts'

describe('ffmpegTimeoutMs', () => {
  test('60 s plus 1 s per MB, capped at 30 min', () => {
    expect(ffmpegTimeoutMs(0)).toBe(60_000)
    expect(ffmpegTimeoutMs(10_000_000)).toBe(70_000)
    expect(ffmpegTimeoutMs(10 ** 12)).toBe(1_800_000)
  })
})

describe('framing (pure)', () => {
  test('parseOutputFormat: empty is mp3, the four formats pass, anything else is null', () => {
    expect(parseOutputFormat('')).toBe('mp3')
    for (const f of ['mp3', 'opus', 'wav', 'pcm']) expect(parseOutputFormat(f)).toBe(f as never)
    expect(parseOutputFormat('flac')).toBeNull()
  })

  test('pcmToWav writes a 44-byte header for mono 16-bit 24 kHz', () => {
    const wav = new DataView(pcmToWav(new Uint8Array(100)))
    expect(wav.byteLength).toBe(144)
    expect(wav.getUint32(4, true)).toBe(136)
    expect(wav.getUint32(24, true)).toBe(24_000)
    expect(wav.getUint32(40, true)).toBe(100)
  })

  test('silencePcm is 400 ms of zeroed s16le mono; concatPcm puts it between parts only', () => {
    expect(silencePcm(24_000).byteLength).toBe(19_200)
    const joined = concatPcm([
      { pcm: Uint8Array.from([1, 0]), sampleRate: 24_000 },
      { pcm: Uint8Array.from([2, 0]), sampleRate: 24_000 },
    ])
    expect(joined.pcm.byteLength).toBe(2 + 19_200 + 2)
    expect(joined.pcm[19_202]).toBe(2)
    expect(concatPcm([{ pcm: Uint8Array.from([1, 0]), sampleRate: 16_000 }])).toEqual({
      pcm: Uint8Array.from([1, 0]),
      sampleRate: 16_000,
    })
  })

  test('concatPcm refuses parts at different sample rates', () => {
    expect(() =>
      concatPcm([
        { pcm: Uint8Array.from([1, 0]), sampleRate: 24_000 },
        { pcm: Uint8Array.from([1, 0]), sampleRate: 16_000 },
      ]),
    ).toThrow(/24000 Hz and 16000 Hz/)
  })

  test('parseSilence pairs start/end lines and runs a trailing start to the end', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 1.5',
      '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1',
      '[silencedetect @ 0x1] silence_start: 8',
    ].join('\n')
    expect(parseSilence(stderr, 10)).toEqual([
      { start: 1.5, end: 2.5 },
      { start: 8, end: 10 },
    ])
    expect(parseSilence(stderr, null)).toEqual([{ start: 1.5, end: 2.5 }])
  })
})

describe.skipIf(!hasFfmpeg)('ffmpeg boundary', () => {
  const media = ffmpegMedia({ mp3BitrateKbps: 48, opusBitrateKbps: 32 })
  const pcm = new Uint8Array(24_000) // 0.5 s of silence at 24 kHz s16

  test('pcm output is raw s16le mono 24 kHz, byte-exact', async () => {
    const out = await media.transcode(pcm, { kind: 'pcm', sampleRate: 24_000 }, 'pcm')
    expect(out.contentType).toBe('audio/pcm')
    expect(out.bytes.byteLength).toBe(24_000)
  })

  test('wav output carries a RIFF header and probes at ~0.5 s', async () => {
    const out = await media.transcode(pcm, { kind: 'pcm', sampleRate: 24_000 }, 'wav')
    expect(new TextDecoder().decode(new Uint8Array(out.bytes).subarray(0, 4))).toBe('RIFF')
    expect(Math.abs((await media.duration(out.bytes)) - 0.5)).toBeLessThan(0.05)
  })

  test('mp3 and opus encode; mp3 round-trips through auto decode back to pcm', async () => {
    const mp3 = await media.transcode(pcm, { kind: 'pcm', sampleRate: 24_000 }, 'mp3')
    expect(mp3.contentType).toBe('audio/mpeg')
    const opus = await media.transcode(pcm, { kind: 'pcm', sampleRate: 24_000 }, 'opus')
    expect(opus.contentType).toBe('audio/ogg')
    const back = await media.transcode(new Uint8Array(mp3.bytes), { kind: 'auto' }, 'pcm')
    expect(back.bytes.byteLength % 2).toBe(0)
    expect(back.bytes.byteLength).toBeGreaterThan(20_000)
  })

  test('an undecodable input fails loudly; duration of garbage stays 0', async () => {
    const garbage = new TextEncoder().encode('not audio at all')
    let error: unknown
    await media.compressForStt(garbage, { bitrateKbps: 32 }).catch((e: unknown) => {
      error = e
    })
    expect(String(error)).toContain('ffmpeg compressForStt failed')
    expect(await media.duration(garbage)).toBe(0)
  })

  test('abort kills a running ffmpeg and rejects with the signal reason, promptly', async () => {
    const ctrl = new AbortController()
    const started = Date.now()
    const run = runGuarded(
      ['ffmpeg', '-hide_banner', '-f', 'lavfi', '-i', 'anullsrc', '-t', '3600', '-f', 'null', '-'],
      {
        inputBytes: 0,
        signal: ctrl.signal,
      },
    )
    setTimeout(() => ctrl.abort(new Error('stop now')), 200)
    expect((await caught(run)).message).toBe('stop now')
    expect(Date.now() - started).toBeLessThan(5000)
    const pre = new AbortController()
    pre.abort(new Error('already'))
    expect((await caught(media.duration(new Uint8Array(10), { signal: pre.signal }))).message).toBe('already')
    expect((await caught(media.transcode(pcm, { kind: 'auto' }, 'pcm', { signal: pre.signal }))).message).toBe(
      'already',
    )
  })

  test('detectSilence rejects on abort instead of returning []', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('gone'))
    const err = await caught(media.detectSilence(pcm, { noiseDb: -30, minDurationSec: 0.2, signal: ctrl.signal }))
    expect(err.message).toBe('gone')
  })

  test('a process that exits without reading stdin is an exit code, not an EPIPE rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const res = await runGuarded(['sh', '-c', 'exit 3'], { stdin: new Uint8Array(8_000_000), inputBytes: 0 })
      expect(res.exitCode).toBe(3)
      const err = await caught(media.transcode(new Uint8Array(8_000_000), { kind: 'auto' }, 'mp3'))
      expect(err.message).toContain('ffmpeg transcode failed')
      await Bun.sleep(50)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('slice cuts the requested span; detectSilence finds none in a steady tone and [] on garbage', async () => {
    const tone = await toneFile(3, { format: 'mp3' })
    const slice = await media.slice(tone, 1, 1, { bitrateKbps: 32 })
    expect(Math.abs((await media.duration(slice)) - 1)).toBeLessThan(0.15)
    expect(await media.detectSilence(tone, { noiseDb: -30, minDurationSec: 0.2 })).toEqual([])
    expect(await media.detectSilence(new Uint8Array(10), { noiseDb: -30, minDurationSec: 0.2 })).toEqual([])
  })

  test('detectSilence reports a range to the end when the file ends in silence', async () => {
    const silent = await media.transcode(new Uint8Array(48_000), { kind: 'pcm', sampleRate: 24_000 }, 'wav')
    const ranges = await media.detectSilence(new Uint8Array(silent.bytes), { noiseDb: -30, minDurationSec: 0.2 })
    expect(ranges).toHaveLength(1)
    expect(Math.abs((ranges[0]?.end ?? 0) - 1)).toBeLessThan(0.05)
  })
})
