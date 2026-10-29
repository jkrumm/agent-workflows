import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { caught } from '../../testing/index.ts'
import {
  applyGainDb,
  buildFfmetadata,
  buildMuxTurns,
  chaptersFromSegments,
  concatWithGaps,
  masterPodcastMp3,
  matchHostLoudness,
  measureLoudnessLufs,
} from './mux.ts'

// Real ffmpeg on tiny generated PCM: no fixtures, no skips (CI installs ffmpeg).

/** s16le mono sine at 440 Hz. Pure digital silence crashes some libmp3lame builds, so every fixture carries a tone. */
function sine(amplitude: number, seconds: number, sampleRate = 24_000): Uint8Array {
  const n = Math.round(seconds * sampleRate)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 32767 * amplitude)
  return new Uint8Array(out.buffer)
}

/** Minimal 1x1 transparent PNG. */
const TINY_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
)

const BASE_TAGS = {
  title: 'Episode One',
  album: 'Hermes Briefings',
  artist: 'Jonas & Lena',
  albumArtist: 'Hermes',
  comment: 'Generated briefing',
  date: '2026-09-02',
  genre: 'News',
  language: 'deu',
  track: 1,
}

interface Probe {
  chapters?: Array<{ start_time: string; end_time: string; tags?: Record<string, string> }>
  streams?: Array<{ codec_type: string; codec_name: string; disposition?: { attached_pic?: number } }>
  format?: { tags?: Record<string, string> }
}

async function probe(mp3: Uint8Array): Promise<Probe> {
  const dir = await mkdtemp(join(tmpdir(), 'agw-podcast-mux-test-'))
  try {
    const path = join(dir, 'episode.mp3')
    await Bun.write(path, mp3)
    const proc = Bun.spawn(
      ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_chapters', '-show_streams', '-show_format', path],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    return JSON.parse(out) as Probe
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const tagOf = (p: Probe, key: string): string | undefined => {
  const tags = p.format?.tags ?? {}
  return tags[key] ?? tags[key.toUpperCase()]
}

describe('concatWithGaps', () => {
  test('inserts gapMsAfter silence between turns and reports per-turn start offsets', () => {
    const sampleRate = 24_000
    const bytesPerMs = (sampleRate * 2) / 1000
    const a = { pcm: new Uint8Array(Math.round(bytesPerMs * 1000)).fill(1), sampleRate, gapMsAfter: 400 }
    const b = { pcm: new Uint8Array(Math.round(bytesPerMs * 500)).fill(2), sampleRate, gapMsAfter: 0 }

    const { pcm, sampleRate: sr, turnStartsMs, totalMs } = concatWithGaps([a, b])

    expect(sr).toBe(sampleRate)
    expect(turnStartsMs).toEqual([0, 1400])
    expect(totalMs).toBe(1900)
    expect(pcm.byteLength).toBe(a.pcm.byteLength + Math.round(bytesPerMs * 400) + b.pcm.byteLength)
    // The gap between the two turns is zeroed.
    const gapStart = a.pcm.byteLength
    const gapBytes = Math.round(bytesPerMs * 400)
    expect(pcm.slice(gapStart, gapStart + gapBytes).every((byte) => byte === 0)).toBe(true)
    expect(pcm.slice(pcm.byteLength - b.pcm.byteLength)).toEqual(b.pcm)
  })

  test('empty input returns an empty, zero-duration result', () => {
    expect(concatWithGaps([])).toEqual({ pcm: new Uint8Array(0), sampleRate: 0, turnStartsMs: [], totalMs: 0 })
  })

  test('mismatched sample rates throw', () => {
    expect(() =>
      concatWithGaps([
        { pcm: new Uint8Array(4), sampleRate: 24_000, gapMsAfter: 0 },
        { pcm: new Uint8Array(4), sampleRate: 44_100, gapMsAfter: 0 },
      ]),
    ).toThrow('same sampleRate')
  })
})

describe('buildFfmetadata', () => {
  test("chapter END is the next chapter's START, and the last chapter's END is totalMs", () => {
    const chapters = [
      { title: 'Intro', startMs: 0 },
      { title: 'Main', startMs: 5000 },
      { title: 'Outro', startMs: 12_000 },
    ]
    const meta = buildFfmetadata(chapters, 15_000, BASE_TAGS)

    expect(meta.startsWith(';FFMETADATA1\n')).toBe(true)
    expect(meta).toContain('title=Episode One')
    expect(meta).toContain('album_artist=Hermes')
    expect(meta).toContain('language=deu')
    expect(meta).toContain('track=1')

    const blocks = meta.split('[CHAPTER]').slice(1)
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toContain('START=0')
    expect(blocks[0]).toContain('END=5000')
    expect(blocks[0]).toContain('title=Intro')
    expect(blocks[1]).toContain('START=5000')
    expect(blocks[1]).toContain('END=12000')
    expect(blocks[2]).toContain('START=12000')
    expect(blocks[2]).toContain('END=15000')
  })

  test('escapes =, ;, #, backslash, and newline in tag values', () => {
    const meta = buildFfmetadata([], 1000, { ...BASE_TAGS, title: 'A=B; C#D\\E\nF' })
    expect(meta).toContain('title=A\\=B\\; C\\#D\\\\E\\\nF')
  })

  test('escapes chapter titles too', () => {
    const meta = buildFfmetadata([{ title: 'Q=A; #1', startMs: 0 }], 1000, BASE_TAGS)
    expect(meta).toContain('title=Q\\=A\\; \\#1')
  })
})

describe('masterPodcastMp3 (real ffmpeg)', () => {
  const sampleRate = 24_000
  const pcm = sine(0.1, 2, sampleRate)
  const chapters = [
    { title: 'Chapter 1', startMs: 0 },
    { title: 'Chapter 2', startMs: 1000 },
  ]

  test('produces an MP3 with embedded chapters, title tag and an attached cover', async () => {
    const mp3 = await masterPodcastMp3(pcm, sampleRate, { chapters, tags: BASE_TAGS, cover: TINY_PNG, bitrateKbps: 64 })
    expect(mp3.byteLength).toBeGreaterThan(0)
    // ID3v2 header: "ID3" then major version 3.
    expect(Buffer.from(mp3.slice(0, 4)).toString('latin1', 0, 3)).toBe('ID3')
    expect(mp3[3]).toBe(3)

    const info = await probe(mp3)
    expect(info.chapters).toHaveLength(2)
    expect(info.chapters?.map((c) => c.tags?.title)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(Number(info.chapters?.[0]?.start_time)).toBeCloseTo(0, 2)
    expect(Number(info.chapters?.[1]?.start_time)).toBeCloseTo(1, 2)
    expect(tagOf(info, 'title')).toBe('Episode One')
    expect(tagOf(info, 'artist')).toBe('Jonas & Lena')
    expect(info.streams?.find((s) => s.codec_type === 'audio')?.codec_name).toBe('mp3')
    const cover = info.streams?.find((s) => s.codec_type === 'video')
    expect(cover?.codec_name).toBe('png')
    expect(cover?.disposition?.attached_pic).toBe(1)
  })

  test('masters without a cover: no video stream', async () => {
    const mp3 = await masterPodcastMp3(pcm, sampleRate, {
      chapters: [{ title: 'Only', startMs: 0 }],
      tags: BASE_TAGS,
      bitrateKbps: 48,
    })
    expect(mp3.byteLength).toBeGreaterThan(0)
    const info = await probe(mp3)
    expect(info.chapters).toHaveLength(1)
    expect(info.streams?.some((s) => s.codec_type === 'video')).toBe(false)
  })

  test('a failing ffmpeg run throws with its exit code', async () => {
    const error = await caught(masterPodcastMp3(pcm, 0, { chapters, tags: BASE_TAGS, bitrateKbps: 64 }))
    expect(error.message).toContain('ffmpeg podcast mastering failed')
  })
})

describe('host loudness matching', () => {
  test('applyGainDb scales samples and clips at full scale', () => {
    const quiet = sine(0.1, 0.01)
    const louder = applyGainDb(quiet, 6)
    const q = new Int16Array(quiet.buffer, quiet.byteOffset, quiet.byteLength / 2)
    const l = new Int16Array(louder.buffer, louder.byteOffset, louder.byteLength / 2)
    const iq = q.findIndex((v) => v > 1000)
    expect((l[iq] ?? 0) / (q[iq] ?? 1)).toBeCloseTo(1.995, 1)
    const hot = applyGainDb(sine(0.9, 0.01), 12)
    const h = new Int16Array(hot.buffer, hot.byteOffset, hot.byteLength / 2)
    expect(Math.max(...h)).toBe(32_767)
    expect(applyGainDb(quiet, 0)).toBe(quiet)
  })

  test('measureLoudnessLufs reads a tone, and null for digital silence', async () => {
    const lufs = await measureLoudnessLufs(sine(0.5, 2), 24_000)
    expect(lufs).not.toBeNull()
    expect(lufs ?? 0).toBeLessThan(0)
    expect(lufs ?? -100).toBeGreaterThan(-30)
    expect(await measureLoudnessLufs(new Uint8Array(24_000 * 2 * 2), 24_000)).toBeNull()
  })

  test('matchHostLoudness levels a loud and a quiet host onto the same target', async () => {
    const turns = [
      { speaker: 'A', pcm: sine(0.05, 2), sampleRate: 24_000 },
      { speaker: 'B', pcm: sine(0.5, 2), sampleRate: 24_000 },
    ]
    const before = await Promise.all(turns.map((t) => measureLoudnessLufs(t.pcm, t.sampleRate)))
    expect((before[1] ?? 0) - (before[0] ?? 0)).toBeGreaterThan(15)

    const { turns: levelled, gainsDb } = await matchHostLoudness(turns, -20)
    expect(gainsDb.A).toBeGreaterThan(0)
    expect(gainsDb.B).toBeLessThan(0)
    const after = await Promise.all(levelled.map((t) => measureLoudnessLufs(t.pcm, t.sampleRate)))
    expect(Math.abs((after[0] ?? 0) - (after[1] ?? 0))).toBeLessThan(1.5)
    expect(Math.abs((after[0] ?? 0) - -20)).toBeLessThan(1.5)
  })

  test('the gain is capped at 12 dB either way', async () => {
    const { gainsDb } = await matchHostLoudness(
      [
        { speaker: 'A', pcm: sine(0.005, 2), sampleRate: 24_000 },
        { speaker: 'B', pcm: sine(0.9, 2), sampleRate: 24_000 },
      ],
      -20,
    )
    expect(gainsDb.A).toBe(12)
    expect(gainsDb.B).toBe(-12)
  })
})

describe('buildMuxTurns', () => {
  test('short gap before a short interjection, zero gap after the last turn', () => {
    const synthOutputs = [0, 1, 2].map(() => ({ pcm: new Uint8Array(4), sampleRate: 24_000 }))
    const turnTexts = ['A longer opening line right here', 'Echt?', 'A final closing statement with plenty of words']

    const muxTurns = buildMuxTurns({ synthOutputs, turnTexts, gapMs: 380, shortGapMs: 160 })

    expect(muxTurns[0]?.gapMsAfter).toBe(160) // next turn ("Echt?") is a short interjection
    expect(muxTurns[1]?.gapMsAfter).toBe(380) // next turn is a normal-length line
    expect(muxTurns[2]?.gapMsAfter).toBe(0) // last turn never gets a trailing gap
  })

  test('feeds concatWithGaps and chaptersFromSegments end to end', () => {
    const sampleRate = 24_000
    const pcmOf = (seconds: number) => new Uint8Array(sampleRate * 2 * seconds)
    const synthOutputs = [1, 2, 1].map((s) => ({ pcm: pcmOf(s), sampleRate }))
    const segments = [
      { title: 'Intro', turns: [{}, {}] },
      { title: 'Deep dive', turns: [{}] },
    ]
    const turnTexts = [
      'Erste Zeile hier, die lang genug ist.',
      'Zweite Zeile, ebenfalls ziemlich lang und ausführlich geraten.',
      'Ja.',
    ]

    const mux = concatWithGaps(buildMuxTurns({ synthOutputs, turnTexts, gapMs: 400, shortGapMs: 100 }))

    // turn 0: 1000 + 400, turn 1: 2000 + 100 (next is "Ja."), turn 2 starts at 3500
    expect(mux.turnStartsMs).toEqual([0, 1400, 3500])
    expect(chaptersFromSegments(segments, mux.turnStartsMs)).toEqual([
      { title: 'Intro', startMs: 0 },
      { title: 'Deep dive', startMs: 3500 },
    ])
  })
})

describe('chaptersFromSegments', () => {
  test("one chapter per segment, at its first turn's offset", () => {
    const segments = [
      { title: 'Intro', turns: [{ speaker: 'A' }, { speaker: 'B' }] },
      { title: 'Deep dive', turns: [{ speaker: 'A' }] },
    ]
    expect(chaptersFromSegments(segments, [0, 1000, 2500])).toEqual([
      { title: 'Intro', startMs: 0 },
      { title: 'Deep dive', startMs: 2500 },
    ])
  })

  test('unitOfTurn maps a turn to its multi-speaker run', () => {
    const segments = [
      { title: 'S1', turns: [{}, {}, {}] },
      { title: 'S2', turns: [{}, {}] },
    ]
    const unitOfTurn = [0, 0, 1, 2, 2]
    expect(chaptersFromSegments(segments, [0, 5000, 9000], (t) => unitOfTurn[t] ?? t)).toEqual([
      { title: 'S1', startMs: 0 },
      { title: 'S2', startMs: 9000 },
    ])
  })
})
