#!/usr/bin/env bun
// Wave 8 `podcast` offline parity, rule 2 (docs/research/2026-10-29-wave8-ports.md §podcast), free and offline:
//   bun scripts/eval-legacy/podcast-units.ts
// Runs the ported multi-speaker segmentation (`packages/audio/src/workflows/podcast-produce/synth.ts`:
// `turnsForSynthesis`, then `unitsForMultiSpeaker`) and legacy's own (imported from the audio-gateway checkout,
// AGW_LEGACY_AUDIO, default ~/SourceRoot/audio-gateway) on every recorded `script.json`, at legacy's default
// `PODCAST_MULTISPEAKER_MAX_CHARS` (3000) and, as a stress, at 1500 and 6000. Prints per-script equality of the units
// (deep, exact) and of the turns they are packed from. Reads the episode directories read-only; prints ids and numbers
// only, never script text. Exit 1 on any difference.
import { deepEqual } from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostValue } from '../../packages/audio/src/workflows/podcast/schema.ts'
import { turnsForSynthesis, unitsForMultiSpeaker } from '../../packages/audio/src/workflows/podcast-produce/synth.ts'

const LEGACY = process.env.AGW_LEGACY_AUDIO ?? join(homedir(), 'SourceRoot', 'audio-gateway')

// Legacy's synth module pulls in its config singleton, which requires these at import; placeholders, never called.
for (const [key, value] of Object.entries({
  IU_API_KEY: 'offline-parity',
  IU_OPENAI_BASE_URL: 'https://iu.example.com/openai/v1',
  IU_GEMINI_BASE_URL: 'https://iu.example.com/gemini/v1beta',
  IU_REPLICATE_BASE_URL: 'https://iu.example.com/replicate/v1',
  USAGE_DB: ':memory:',
  PROXY_API_KEY: 'offline-parity',
})) {
  process.env[key] ??= value
}
const legacy = (await import(join(LEGACY, 'src', 'podcast-synth.ts'))) as {
  turnsForSynthesis: typeof turnsForSynthesis
  unitsForMultiSpeaker: typeof unitsForMultiSpeaker
}

interface PersistedScript {
  language: 'de' | 'en'
  segments: { title: string; turns: { speaker: 'A' | 'B'; text: string; delivery?: string }[] }[]
  hosts: [HostValue, HostValue]
}

const LIMITS = [3000, 1500, 6000]
const same = (a: unknown, b: unknown): boolean => {
  try {
    deepEqual(a, b)
    return true
  } catch {
    return false
  }
}

const root = join(LEGACY, 'data', 'podcasts')
const ids = readdirSync(root).filter((id) => existsSync(join(root, id, 'script.json')))
let equal = 0
console.log(`script    segments turns ${LIMITS.map((l) => `units@${l}(new/legacy)`.padStart(22)).join(' ')} turns= equal`)
for (const id of ids.sort()) {
  const script = JSON.parse(readFileSync(join(root, id, 'script.json'), 'utf8')) as PersistedScript
  const segmentLengths = script.segments.map((s) => s.turns.length)
  const ported = turnsForSynthesis(script.segments, script.hosts, script.language)
  const original = legacy.turnsForSynthesis(script.segments, script.hosts, script.language)
  const turnsSame = same(ported, original)
  let all = turnsSame
  const cells = LIMITS.map((limit) => {
    const a = unitsForMultiSpeaker(ported, segmentLengths, limit)
    const b = legacy.unitsForMultiSpeaker(original, segmentLengths, limit)
    const ok = same(a, b)
    all &&= ok
    return `${a.length}/${b.length}${ok ? '' : ' DIFF'}`.padStart(22)
  })
  if (all) equal++
  console.log(
    `${id.slice(0, 8)}  ${String(script.segments.length).padStart(8)} ${String(ported.length).padStart(5)} ${cells.join(' ')} ${turnsSame ? 'yes' : 'NO '}    ${all ? 'yes' : 'NO'}`,
  )
}
console.log(`\nunits equal (every limit, and the turns they pack): ${equal}/${ids.length}`)
if (equal !== ids.length) process.exit(1)
