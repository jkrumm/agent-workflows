import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

/** One synthesized unit as stored and journaled. */
export interface StoredUnit extends StoredFile {
  sampleRate: number
  audioSeconds: number
  inputChars: number
  /** True when the audio was found in the store (an interrupted earlier attempt), not synthesized by this one. */
  reused: boolean
}

/** The hash of what a unit is synthesized from (route, voices, texts, styles): the same request reuses its audio. */
export const unitRequestHash = (request: unknown): string =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16)

const unitPaths = (dir: string, index: number, requestHash: string) => {
  const base = join(dir, 'units', `${String(index).padStart(4, '0')}-${requestHash}`)
  return { pcm: `${base}.pcm`, meta: `${base}.json` }
}

interface UnitMeta {
  sha256: string
  bytes: number
  sampleRate: number
  audioSeconds: number
  inputChars: number
}

/** The unit's audio when an earlier attempt stored it for the same request (its sidecar and its hash agree), else null. */
export async function findUnit(dir: string, index: number, requestHash: string): Promise<StoredUnit | null> {
  const paths = unitPaths(dir, index, requestHash)
  if (!existsSync(paths.meta) || !existsSync(paths.pcm)) return null
  try {
    const meta = JSON.parse(await readFile(paths.meta, 'utf8')) as UnitMeta
    const bytes = new Uint8Array(await readFile(paths.pcm))
    if (sha256(bytes) !== meta.sha256) return null
    return { path: paths.pcm, ...meta, reused: true }
  } catch {
    return null
  }
}

/** Store a unit's PCM, then its sidecar: a sidecar exists only for audio that is whole. */
export async function storeUnit(
  dir: string,
  index: number,
  requestHash: string,
  audio: { pcm: Uint8Array; sampleRate: number; audioSeconds: number; inputChars: number },
): Promise<StoredUnit> {
  const paths = unitPaths(dir, index, requestHash)
  const file = await store(paths.pcm, audio.pcm)
  const meta: UnitMeta = {
    sha256: file.sha256,
    bytes: file.bytes,
    sampleRate: audio.sampleRate,
    audioSeconds: audio.audioSeconds,
    inputChars: audio.inputChars,
  }
  await writeAtomic(paths.meta, JSON.stringify(meta))
  return {
    ...file,
    sampleRate: audio.sampleRate,
    audioSeconds: audio.audioSeconds,
    inputChars: audio.inputChars,
    reused: false,
  }
}
