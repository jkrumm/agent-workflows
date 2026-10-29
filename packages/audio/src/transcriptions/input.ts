import type { SilenceRange } from '../media/audio.ts'
import type { AudioScope } from '../scope.ts'

// IU's `POST /audio/transcriptions` has four measured limits: a 25 MiB body (HTTP 500, empty body), gpt-4o-transcribe
// 400s over 1400 s, whisper's ~230 s processing timeout, and gpt-4o-transcribe silently truncating past ~20 min. This
// module makes an upload fit: short clips pass untouched (one ffprobe); anything larger is compressed to 16 kHz mono
// mp3 and, if still too big or too long, time-sliced into chunks whose cuts snap to nearby silence.

export interface PreparedSttInput {
  parts: File[]
  /** Each part's length in seconds, from the cuts. */
  partSeconds: number[]
  compressed: boolean
  totalSeconds: number
}

/** Even the smallest allowed chunk count exceeds `sttMaxChunks`: a 413. */
export class SttChunkLimitError extends Error {}

/** A slice still over `sttMaxUploadBytes` after re-encoding: resending it would reproduce the empty 500, so a 413. */
export class SttChunkTooLargeError extends Error {}

/** The final chunk's `-t` overshoots the end, so float rounding never clips the tail. */
const TAIL_OVERSHOOT_SEC = 2

/** Slack on the chunk count so per-chunk rounding never leaves a chunk over the limit. */
const CHUNK_COUNT_SLACK = 1.1

const mp3File = (name: string, bytes: ArrayBuffer): File => new File([bytes], name, { type: 'audio/mpeg' })

const withMp3Extension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return `${dot === -1 ? name : name.slice(0, dot)}.mp3`
}

/**
 * Snap each hard cut point to the midpoint of the nearest silence within `windowSec`. A snap is discarded (the hard
 * target stays) if it would make the boundaries non-increasing, leave `(0, totalSeconds)`, or push EITHER adjacent
 * chunk over `maxChunkSeconds` (the one ending here, from the decided previous boundary; the one starting here, to the
 * next hard target or the end). Without the second check two neighbours can drift apart and overrun the middle chunk.
 */
export function snapBoundaries(
  targets: number[],
  silences: SilenceRange[],
  opts: { windowSec: number; totalSeconds: number; maxChunkSeconds: number },
): number[] {
  const boundaries: number[] = []
  let prev = 0
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as number
    let snapped: number | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const range of silences) {
      const midpoint = (range.start + range.end) / 2
      const dist = Math.abs(midpoint - target)
      if (dist <= opts.windowSec && dist < bestDist) {
        snapped = midpoint
        bestDist = dist
      }
    }
    const nextBound = i + 1 < targets.length ? (targets[i + 1] as number) : opts.totalSeconds
    const isValid = (b: number): boolean =>
      b > prev && b < opts.totalSeconds && b - prev <= opts.maxChunkSeconds && nextBound - b <= opts.maxChunkSeconds
    const boundary = snapped !== null && isValid(snapped) ? snapped : target
    boundaries.push(boundary)
    prev = boundary
  }
  return boundaries
}

/** Make `file` fit the upstream's size AND duration limits (see the module note). */
export async function prepareSttInput(scope: AudioScope, file: File): Promise<PreparedSttInput> {
  const { config } = scope
  const { media } = scope.deps
  if (file.size <= config.sttMaxUploadBytes) {
    const duration = await media.duration(file)
    if (duration <= config.sttMaxChunkSeconds)
      return { parts: [file], partSeconds: [duration], compressed: false, totalSeconds: duration }
  }

  const original = new Uint8Array(await file.arrayBuffer())
  const compressedBytes = await media.compressForStt(original, { bitrateKbps: config.sttCompressBitrateKbps })
  const compressed = new Uint8Array(compressedBytes)
  const compressedName = withMp3Extension(file.name)
  const totalSeconds = await media.duration(compressedBytes)

  const sizeChunks = Math.ceil((compressedBytes.byteLength / config.sttMaxUploadBytes) * CHUNK_COUNT_SLACK)
  const durationChunks = Math.ceil(totalSeconds / config.sttMaxChunkSeconds)
  const chunkCount = Math.max(sizeChunks, durationChunks, 1)
  if (chunkCount <= 1) {
    return {
      parts: [mp3File(compressedName, compressedBytes)],
      partSeconds: [totalSeconds],
      compressed: true,
      totalSeconds,
    }
  }
  if (chunkCount > config.sttMaxChunks) {
    throw new SttChunkLimitError(
      `upload too large: would need ${chunkCount} chunks, exceeding the ${config.sttMaxChunks}-chunk limit`,
    )
  }

  const targets = Array.from({ length: chunkCount - 1 }, (_, i) => ((i + 1) * totalSeconds) / chunkCount)
  const silences = await media.detectSilence(compressed, {
    noiseDb: config.sttSilenceNoiseDb,
    minDurationSec: config.sttSilenceMinSec,
  })
  const boundaries = snapBoundaries(targets, silences, {
    windowSec: config.sttSilenceWindowSec,
    totalSeconds,
    maxChunkSeconds: config.sttMaxChunkSeconds,
  })
  const snapped = boundaries.filter((b, i) => b !== targets[i]).length
  scope.log.info('stt chunking', { chunkCount, totalSeconds, snappedBoundaries: snapped })

  const cuts = [0, ...boundaries, totalSeconds]
  const parts: File[] = []
  const partSeconds: number[] = []
  for (let i = 0; i < chunkCount; i++) {
    const startSec = cuts[i]
    const endSec = cuts[i + 1]
    if (startSec === undefined || endSec === undefined) throw new Error(`chunk cut index ${i} out of range`)
    const durationSec = endSec - startSec + (i === chunkCount - 1 ? TAIL_OVERSHOOT_SEC : 0)
    // Slice the COMPRESSED buffer, not the original: "cut from the original container AND encode to EOF" gave a final
    // chunk the upstream decoded as near-silence (measured 2026-09-10: 99/99 sentences vs 0).
    const slice = await media.slice(compressed, startSec, durationSec, { bitrateKbps: config.sttCompressBitrateKbps })
    if (slice.byteLength > config.sttMaxUploadBytes) {
      throw new SttChunkTooLargeError(
        `chunk ${i + 1}/${chunkCount} is still ${slice.byteLength} bytes, over the ${config.sttMaxUploadBytes}-byte upload limit`,
      )
    }
    partSeconds.push(endSec - startSec)
    parts.push(mp3File(`${compressedName.replace(/\.mp3$/, '')}.part${i + 1}.mp3`, slice))
  }
  return { parts, partSeconds, compressed: true, totalSeconds }
}
