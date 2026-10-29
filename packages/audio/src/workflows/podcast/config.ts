import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HostValue } from './schema.ts'

// Deployment configuration of the room, from the process env, legacy's variable names where one existed
// (audio-gateway `src/config.ts`). Models are not here: they live in the route table (`routes.pending.ts`).

export interface PodcastConfig {
  /** The two hosts, in speaker order (`PODCAST_HOST_NAMES`, `PODCAST_VOICES`, `PODCAST_SPEEDS`). */
  hosts: [HostValue, HostValue]
  /** Recent episodes shown to the editor (`PODCAST_HISTORY_DEPTH`, default 8). */
  historyDepth: number
  /** Optional valve on the research stage's `research` runs per episode (`PODCAST_RESEARCH_MAX_CALLS`, 0 = none). */
  researchMaxCalls: number
  /** Segment drafts and revisions as a tool loop that lints its own text (`PODCAST_AGENTIC_WRITER`, default on). */
  agentic: boolean
  /** Characters per multi-speaker synth request the writer measures against (`PODCAST_MULTISPEAKER_MAX_CHARS`). */
  maxUnitChars: number
  /** Parallel segment writes and revisions (legacy: 3). */
  concurrency: number
  /** The vault (`AGW_BRAIN_DIR`) `sourcePaths` are read from. */
  vaultDir: string
  /** The owner's voice guide (`voice.md` at the vault root, `AGW_BRAIN_DIR`); unreadable = written from the show bible alone. */
  voicePath: string | null
}

type Env = Record<string, string | undefined>

function pair(env: Env, key: string, fallback: string): [string, string] {
  const parts = (env[key] ?? fallback).split(',').map((p) => p.trim())
  if (parts.length !== 2 || parts.some((p) => !p)) throw new Error(`${key} must name exactly two entries`)
  return [parts[0] as string, parts[1] as string]
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`)
  return value
}

/** The vault checkout every audio workflow reads and writes: `AGW_BRAIN_DIR`, trimmed, default `~/SourceRoot/brain`, absolute. */
export function brainDirFromEnv(env: Env = process.env): string {
  const raw = env.AGW_BRAIN_DIR?.trim().replace(/\/+$/, '')
  return raw ? resolve(raw) : join(homedir(), 'SourceRoot', 'brain')
}

export function podcastConfigFromEnv(env: Env = process.env): PodcastConfig {
  const names = pair(env, 'PODCAST_HOST_NAMES', 'Jonas,Lena')
  // The Gemini multi-speaker lane's prebuilt voices (owner pick 2026-10-25); the produce stage reads them.
  const voices = pair(env, 'PODCAST_VOICES', 'Charon,Erinome')
  const speeds = pair(env, 'PODCAST_SPEEDS', '0.94,1').map((raw) => {
    const v = Number(raw)
    if (!Number.isFinite(v)) throw new Error(`invalid PODCAST_SPEEDS entry "${raw}"`)
    return Math.min(1.2, Math.max(0.7, v))
  })
  const brainDir = brainDirFromEnv(env)
  return {
    hosts: [
      { id: 'A', name: names[0], voice: voices[0], speed: speeds[0] },
      { id: 'B', name: names[1], voice: voices[1], speed: speeds[1] },
    ],
    historyDepth: int(env, 'PODCAST_HISTORY_DEPTH', 8),
    researchMaxCalls: int(env, 'PODCAST_RESEARCH_MAX_CALLS', 0),
    agentic: (env.PODCAST_AGENTIC_WRITER ?? 'on').trim().toLowerCase() !== 'off',
    maxUnitChars: int(env, 'PODCAST_MULTISPEAKER_MAX_CHARS', 3000),
    concurrency: 3,
    vaultDir: brainDir,
    voicePath: join(brainDir, 'voice.md'),
  }
}
