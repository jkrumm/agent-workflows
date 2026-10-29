import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The ffmpeg/ffprobe process boundary. Gemini emits raw s16le PCM, ElevenLabs MP3, and clients ask for one of four
// OpenAI-compatible formats: framing, concatenation and transcoding happen here and nowhere else. STT compression,
// slicing, silence detection and duration probing too. Pure framing helpers are plain functions; everything that
// spawns a process sits behind `MediaPort`, so tests can swap one call without touching the rest.

export const SAMPLE_RATE_DEFAULT = 24_000
const SILENCE_MS = 400

export type AudioOutputFormat = 'mp3' | 'opus' | 'wav' | 'pcm'

export const CONTENT_TYPES: Record<AudioOutputFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

/** A client `response_format`. Empty defaults to `mp3` (OpenAI's default); null means unrecognized (400). */
export function parseOutputFormat(raw: string): AudioOutputFormat | null {
  if (raw === '') return 'mp3'
  if (raw === 'mp3' || raw === 'opus' || raw === 'wav' || raw === 'pcm') return raw
  return null
}

export interface ChunkAudio {
  pcm: Uint8Array
  sampleRate: number
}

/** Raw s16le PCM in a 44-byte WAV header (mono, 16-bit). */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = SAMPLE_RATE_DEFAULT,
  channels = 1,
  bitsPerSample = 16,
): ArrayBuffer {
  const blockAlign = (channels * bitsPerSample) / 8
  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Uint8Array(buffer, 44).set(pcm)
  return buffer
}

/** `SILENCE_MS` of zeroed s16le mono PCM: the join between synthesized chunks. */
export function silencePcm(sampleRate: number): Uint8Array {
  return new Uint8Array(Math.round((SILENCE_MS / 1000) * sampleRate) * 2)
}

/** Concatenate s16le PCM chunks of one sample rate with `SILENCE_MS` of silence between them. */
export function concatPcm(parts: ChunkAudio[]): ChunkAudio {
  const sampleRate = parts[0]?.sampleRate ?? SAMPLE_RATE_DEFAULT
  // Joining two rates as one stream would play part of it at the wrong speed: refused, never guessed.
  const other = parts.find((p) => p.sampleRate !== sampleRate)
  if (other) throw new Error(`cannot join PCM at ${sampleRate} Hz and ${other.sampleRate} Hz`)
  const silenceBytes = silencePcm(sampleRate).byteLength
  const total = parts.reduce((n, p) => n + p.pcm.byteLength, 0) + Math.max(0, parts.length - 1) * silenceBytes
  const out = new Uint8Array(total)
  let offset = 0
  parts.forEach((p, i) => {
    out.set(p.pcm, offset)
    offset += p.pcm.byteLength
    if (i < parts.length - 1) offset += silenceBytes
  })
  return { pcm: out, sampleRate }
}

/** Raw s16le PCM at a known rate, or an auto-detected container (e.g. an MP3 chunk to decode). */
export type TranscodeInput = { kind: 'pcm'; sampleRate: number } | { kind: 'auto' }

export interface Encoded {
  bytes: ArrayBuffer
  contentType: string
}

export interface SilenceRange {
  start: number
  end: number
}

export interface MediaPort {
  /** Between what a lane produced and the format the client asked for; also MP3 -> pcm ahead of concatenation. */
  transcode(input: Uint8Array, from: TranscodeInput, to: AudioOutputFormat): Promise<Encoded>
  /** Seconds, via ffprobe; 0 when it cannot tell (timing is best-effort). */
  duration(data: Blob | ArrayBuffer | Uint8Array): Promise<number>
  /** Any input to 16 kHz mono mp3, lossless for STT (Whisper-class models resample to that internally). */
  compressForStt(input: Uint8Array, opts: { bitrateKbps: number }): Promise<ArrayBuffer>
  /** `[startSec, startSec + durationSec)` re-encoded to 16 kHz mono mp3; `-t` is always passed (see `sliceArgs`). */
  slice(input: Uint8Array, startSec: number, durationSec: number, opts: { bitrateKbps: number }): Promise<ArrayBuffer>
  /** Silent stretches (`silencedetect`); never throws, `[]` on any failure. */
  detectSilence(input: Uint8Array, opts: { noiseDb: number; minDurationSec: number }): Promise<SilenceRange[]>
}

/** 16 kHz mono mp3: the one shape every STT-bound re-encode uses. */
const sttEncodeArgs = (bitrateKbps: number): string[] => [
  '-ar',
  '16000',
  '-ac',
  '1',
  '-c:a',
  'libmp3lame',
  '-b:a',
  `${bitrateKbps}k`,
  '-f',
  'mp3',
  'pipe:1',
]

/**
 * `-t` is NOT optional, even for a final chunk that runs to the end: a slice cut without it is decoded as
 * near-silence by IU's 4o transcribe backend (HTTP 200, one sentence for eight minutes; measured 2026-09-10,
 * 99/99 sentences with `-t`, 0 without). Callers overshoot the end instead of omitting it.
 */
export const sliceArgs = (tmp: string, startSec: number, durationSec: number, bitrateKbps: number): string[] => [
  '-ss',
  String(startSec),
  '-t',
  String(durationSec),
  '-i',
  tmp,
  ...sttEncodeArgs(bitrateKbps),
]

const tmpPath = () => join(tmpdir(), `agw-audio-${crypto.randomUUID()}`)

/** Run ffmpeg over a temp-file copy of `input` (an MP4's moov atom can sit at the end: no pipe) and return stdout. */
async function ffmpegToBuffer(input: Uint8Array, args: (tmp: string) => string[], label: string): Promise<ArrayBuffer> {
  const tmp = tmpPath()
  try {
    await Bun.write(tmp, input)
    const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args(tmp)], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [bytes, errText, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(`ffmpeg ${label} failed (${exitCode}): ${errText.slice(0, 300)}`)
    return bytes
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

const SILENCE_START_RE = /silence_start:\s*(-?[\d.]+)/
const SILENCE_END_RE = /silence_end:\s*(-?[\d.]+)/

/** `silencedetect` stderr into ranges; a trailing unpaired start runs to `totalSeconds` when it is known. */
export function parseSilence(stderr: string, totalSeconds: number | null): SilenceRange[] {
  const ranges: SilenceRange[] = []
  let pendingStart: number | null = null
  for (const line of stderr.split('\n')) {
    const startMatch = SILENCE_START_RE.exec(line)
    if (startMatch?.[1] !== undefined) {
      pendingStart = Number.parseFloat(startMatch[1])
      continue
    }
    const endMatch = SILENCE_END_RE.exec(line)
    if (endMatch?.[1] !== undefined && pendingStart !== null) {
      const end = Number.parseFloat(endMatch[1])
      if (Number.isFinite(pendingStart) && Number.isFinite(end)) ranges.push({ start: pendingStart, end })
      pendingStart = null
    }
  }
  if (pendingStart !== null && totalSeconds !== null && Number.isFinite(pendingStart) && totalSeconds > pendingStart) {
    ranges.push({ start: pendingStart, end: totalSeconds })
  }
  return ranges.sort((a, b) => a.start - b.start)
}

/** The production adapter: the host's `ffmpeg` and `ffprobe`. */
export function ffmpegMedia(opts: { mp3BitrateKbps: number; opusBitrateKbps: number }): MediaPort {
  const outputArgs = (format: AudioOutputFormat): string[] => {
    switch (format) {
      case 'mp3':
        // Low bitrate on purpose: narration, not music.
        return ['-c:a', 'libmp3lame', '-b:a', `${opts.mp3BitrateKbps}k`, '-f', 'mp3']
      case 'opus':
        return ['-c:a', 'libopus', '-b:a', `${opts.opusBitrateKbps}k`, '-application', 'voip', '-f', 'ogg']
      case 'wav':
        // 24 kHz mono s16le WAV: what Hermes' OpenAIStreamer expects.
        return ['-ar', String(SAMPLE_RATE_DEFAULT), '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav']
      case 'pcm':
        return ['-ar', String(SAMPLE_RATE_DEFAULT), '-ac', '1', '-f', 's16le']
    }
  }

  const duration: MediaPort['duration'] = async (data) => {
    const tmp = tmpPath()
    try {
      await Bun.write(tmp, data instanceof Blob ? await data.arrayBuffer() : data)
      const proc = Bun.spawn(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', tmp],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const d = Number.parseFloat(out.trim())
      return Number.isFinite(d) ? d : 0
    } catch {
      return 0
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  return {
    async transcode(input, from, to) {
      const inputArgs =
        from.kind === 'pcm'
          ? ['-f', 's16le', '-ar', String(from.sampleRate), '-ac', '1', '-i', 'pipe:0']
          : ['-i', 'pipe:0']
      const proc = Bun.spawn(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', ...inputArgs, ...outputArgs(to), 'pipe:1'],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      )
      // Read stdout and stderr while writing, so the output pipe never deadlocks.
      const stdout = new Response(proc.stdout).arrayBuffer()
      const stderr = new Response(proc.stderr).text()
      void proc.stdin.write(input)
      await proc.stdin.end()
      const [bytes, errText, exitCode] = await Promise.all([stdout, stderr, proc.exited])
      if (exitCode !== 0) throw new Error(`ffmpeg transcode failed (${exitCode}): ${errText.slice(0, 300)}`)
      return { bytes, contentType: CONTENT_TYPES[to] }
    },
    duration,
    compressForStt: (input, o) =>
      ffmpegToBuffer(input, (tmp) => ['-i', tmp, ...sttEncodeArgs(o.bitrateKbps)], 'compressForStt'),
    slice: (input, startSec, durationSec, o) =>
      ffmpegToBuffer(input, (tmp) => sliceArgs(tmp, startSec, durationSec, o.bitrateKbps), 'slice'),
    async detectSilence(input, o) {
      const tmp = tmpPath()
      try {
        await Bun.write(tmp, input)
        // silencedetect prints at the info level on stderr: no `-loglevel error` here.
        const proc = Bun.spawn(
          [
            'ffmpeg',
            '-hide_banner',
            '-i',
            tmp,
            '-af',
            `silencedetect=noise=${o.noiseDb}dB:d=${o.minDurationSec}`,
            '-f',
            'null',
            '-',
          ],
          { stdout: 'ignore', stderr: 'pipe' },
        )
        const stderr = await new Response(proc.stderr).text()
        if ((await proc.exited) !== 0) return []
        const needsEnd = /silence_start/.test(
          stderr
            .split('\n')
            .reverse()
            .find((l) => /silence_(start|end)/.test(l)) ?? '',
        )
        return parseSilence(stderr, needsEnd ? await duration(input) : null)
      } catch {
        return []
      } finally {
        await unlink(tmp).catch(() => {})
      }
    },
  }
}
