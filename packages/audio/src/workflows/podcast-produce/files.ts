import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Usage } from '../../../../runtime/src/index.ts'

// The episode's files in the platform's artifact store (`packages/host/src/artifacts.ts`, `<root>/podcast/<episode>/`).
// A synthesized unit is written here the moment it is done, with a sidecar naming what it was synthesized from, so a
// step that dies after the audio landed but before the journal recorded it finds the audio on disk and is not billed
// again. The journal holds paths and hashes, never audio bytes.

/** What the journal records for a stored file. */
export interface StoredFile {
  path: string
  sha256: string
  bytes: number
}

export const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

/** Write `bytes` to `path` atomically (a temp file in the same directory, then a rename): never a half file. */
export async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(tmp, bytes, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function store(path: string, bytes: Uint8Array): Promise<StoredFile> {
  await writeAtomic(path, bytes)
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
}

/** A stored file's bytes, checked against the hash the journal recorded. */
export async function readStored(file: StoredFile): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(file.path))
  const actual = sha256(bytes)
  if (actual !== file.sha256) {
    throw new Error(
      `${basename(file.path)} changed on disk since it was journaled (sha256 ${actual}, expected ${file.sha256})`,
    )
  }
  return bytes
}

/**
 * A file a billed call produced, with what that call reported: when an attempt dies after the file landed but before its
 * step recorded the usage, the attempt that reuses the file records it, so the journal's cost stays complete.
 */
interface Sidecar<M> {
  sha256: string
  bytes: number
  /** What the producing request was: a sidecar for another request is not this file. */
  requestHash: string
  /** The step (`<runId>:<stepId>`) whose attempt made the call and was billed for it. */
  producedBy: string
  usage: Usage[]
  meta: M
}

/** Who was billed for a stored file and what the call reported. */
export interface Billed {
  producedBy: string
  usage: Usage[]
}

/**
 * The usage a reuse records: the producing call's, when the attempt that made it was this same step's (it died before
 * its step recorded the usage); none when another run paid for the file.
 */
export const usageToRecord = (found: Billed, stepKey: string): Usage[] =>
  found.producedBy === stepKey ? found.usage : []

/** The file and its sidecar when both are whole and agree with `requestHash`, else null. */
async function findBilled<M>(
  path: string,
  sidecarPath: string,
  requestHash: string,
): Promise<{ file: StoredFile; producedBy: string; usage: Usage[]; meta: M } | null> {
  if (!existsSync(sidecarPath) || !existsSync(path)) return null
  try {
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Sidecar<M>
    if (sidecar.requestHash !== requestHash) return null
    const bytes = new Uint8Array(await readFile(path))
    if (sha256(bytes) !== sidecar.sha256) return null
    return {
      file: { path, sha256: sidecar.sha256, bytes: sidecar.bytes },
      producedBy: sidecar.producedBy,
      usage: sidecar.usage ?? [],
      meta: sidecar.meta,
    }
  } catch {
    return null
  }
}

/** The file, then its sidecar: a sidecar exists only for a file that is whole. */
async function storeBilled<M>(
  path: string,
  sidecarPath: string,
  bytes: Uint8Array,
  requestHash: string,
  billed: Billed,
  meta: M,
): Promise<StoredFile> {
  const file = await store(path, bytes)
  const sidecar: Sidecar<M> = { sha256: file.sha256, bytes: file.bytes, requestHash, ...billed, meta }
  await writeAtomic(sidecarPath, JSON.stringify(sidecar))
  return file
}

/** One synthesized unit as stored and journaled. */
export interface StoredUnit extends StoredFile {
  sampleRate: number
  audioSeconds: number
  inputChars: number
  /** True when the audio was found in the store (an interrupted earlier attempt), not synthesized by this one. */
  reused: boolean
}

/** The hash of what a file is produced from (route, voices, texts, styles; a cover's prompt): the same request reuses it. */
export const unitRequestHash = (request: unknown): string =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16)

const unitPaths = (dir: string, index: number, requestHash: string) => {
  const base = join(dir, 'units', `${String(index).padStart(4, '0')}-${requestHash}`)
  return { pcm: `${base}.pcm`, meta: `${base}.json` }
}

type UnitMeta = Pick<StoredUnit, 'sampleRate' | 'audioSeconds' | 'inputChars'>

/** The unit's audio and the usage its synthesis reported, when an earlier attempt stored it for the same request. */
export async function findUnit(
  dir: string,
  index: number,
  requestHash: string,
): Promise<{ unit: StoredUnit; billed: Billed } | null> {
  const paths = unitPaths(dir, index, requestHash)
  const found = await findBilled<UnitMeta>(paths.pcm, paths.meta, requestHash)
  return found
    ? {
        unit: { ...found.file, ...found.meta, reused: true },
        billed: { producedBy: found.producedBy, usage: found.usage },
      }
    : null
}

/** Store a unit's PCM, then its sidecar with the usage its synthesis reported. */
export async function storeUnit(
  dir: string,
  index: number,
  requestHash: string,
  audio: { pcm: Uint8Array; sampleRate: number; audioSeconds: number; inputChars: number },
  billed: Billed,
): Promise<StoredUnit> {
  const paths = unitPaths(dir, index, requestHash)
  const meta: UnitMeta = {
    sampleRate: audio.sampleRate,
    audioSeconds: audio.audioSeconds,
    inputChars: audio.inputChars,
  }
  const file = await storeBilled(paths.pcm, paths.meta, audio.pcm, requestHash, billed, meta)
  return { ...file, ...meta, reused: false }
}

const coverPaths = (dir: string) => ({ png: join(dir, 'cover.png'), meta: join(dir, 'cover.json') })

/** The cover and the usage its generation reported, when an earlier attempt stored it for the same prompt. */
export async function findCover(
  dir: string,
  requestHash: string,
): Promise<{ file: StoredFile; billed: Billed } | null> {
  const paths = coverPaths(dir)
  const found = await findBilled<null>(paths.png, paths.meta, requestHash)
  return found ? { file: found.file, billed: { producedBy: found.producedBy, usage: found.usage } } : null
}

export function storeCover(dir: string, requestHash: string, png: Uint8Array, billed: Billed): Promise<StoredFile> {
  const paths = coverPaths(dir)
  return storeBilled(paths.png, paths.meta, png, requestHash, billed, null)
}
