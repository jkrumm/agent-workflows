#!/usr/bin/env bun
// Wave 8 `podcast` offline parity, rule 1 (docs/research/2026-10-29-wave8-ports.md §podcast), free and offline:
//   bun scripts/eval-legacy/podcast-lint.ts
// Runs the ported lint (`packages/audio/src/workflows/podcast/lint.ts`) and legacy's own `lintSegments` (imported from
// the audio-gateway checkout, AGW_LEGACY_AUDIO, default ~/SourceRoot/audio-gateway) on every recorded script in its
// ledger, with the options the writers' room lints the finished draft with (glossary from the dossier, host names,
// the source, the outline's asks and opening frame). Prints per-script equality (metrics and every finding, deep), then
// the input to rule 6: total findings per 10 turns for the 10 most recent done episodes. Reads the ledger and the
// episode directories read-only; prints ids and numbers only, never script text.
import { Database } from 'bun:sqlite'
import { deepEqual } from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type LintOptions, lintSegments } from '../../packages/audio/src/workflows/podcast/lint.ts'
import type { ScriptSegment } from '../../packages/audio/src/workflows/podcast/script.ts'

const LEGACY = process.env.AGW_LEGACY_AUDIO ?? join(homedir(), 'SourceRoot', 'audio-gateway')
const legacy = (await import(join(LEGACY, 'src', 'podcast-lint.ts'))) as { lintSegments: typeof lintSegments }

interface Job {
  id: string
  status: string
  created_at: string
  request_json: string
}

interface PersistedScript {
  segments: ScriptSegment[]
  hosts: { id: string; name: string }[]
  asks?: { ask: string; segmentIndex: number }[]
  openingFrame?: string[]
}

const db = new Database(join(LEGACY, 'data', 'podcasts.db'), { readonly: true })
const jobs = db.query<Job, []>('select id, status, created_at, request_json from podcast_job order by created_at').all()

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

function optionsFor(job: Job, script: PersistedScript): LintOptions {
  const dir = join(LEGACY, 'data', 'podcasts', job.id)
  const dossier = readJson<{ glossary?: { term: string }[] }>(join(dir, 'dossier.json'))
  const request = JSON.parse(job.request_json) as { source?: string }
  return {
    glossaryTerms: (dossier?.glossary ?? []).map((g) => g.term),
    hostNames: script.hosts.map((h) => h.name),
    ...(request.source !== undefined ? { source: request.source } : {}),
    ...(script.asks ? { asks: script.asks } : {}),
    ...(script.openingFrame ? { openingFrame: script.openingFrame } : {}),
  }
}

let equal = 0
let compared = 0
const perTen: { id: string; date: string; findings: number; turns: number; perTen: number }[] = []
console.log('script    status  segments turns findings(new/legacy) equal')
for (const job of jobs) {
  const script = readJson<PersistedScript>(join(LEGACY, 'data', 'podcasts', job.id, 'script.json'))
  if (!script) {
    console.log(`${job.id.slice(0, 8)}  ${job.status.padEnd(6)}  no script.json`)
    continue
  }
  const options = optionsFor(job, script)
  const ported = lintSegments(script.segments, options)
  const original = legacy.lintSegments(script.segments, options)
  let same = true
  try {
    deepEqual(ported, original)
  } catch {
    same = false
  }
  compared++
  if (same) equal++
  const turns = script.segments.reduce((n, s) => n + s.turns.length, 0)
  console.log(
    `${job.id.slice(0, 8)}  ${job.status.padEnd(6)}  ${String(script.segments.length).padStart(8)} ${String(turns).padStart(5)} ${`${ported.findings.length}/${original.findings.length}`.padStart(20)} ${same ? 'yes' : 'NO'}`,
  )
  if (job.status === 'done') {
    perTen.push({
      id: job.id.slice(0, 8),
      date: job.created_at.slice(0, 10),
      findings: ported.findings.length,
      turns,
      perTen: turns > 0 ? (ported.findings.length / turns) * 10 : 0,
    })
  }
}
console.log(`\nparity: ${equal}/${compared} scripts equal (metrics and every finding)`)

const recent = perTen.slice(-10)
console.log('\nrule 6 input: findings per 10 turns, the 10 most recent done episodes (ported lint, room options)')
for (const e of recent) console.log(`${e.id}  ${e.date}  ${e.findings} findings / ${e.turns} turns = ${e.perTen.toFixed(2)}`)
const sorted = recent.map((e) => e.perTen).sort((a, b) => a - b)
const quantile = (q: number) => {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo)
}
console.log(`median ${quantile(0.5).toFixed(2)}, 75th percentile ${quantile(0.75).toFixed(2)} (linear interpolation)`)
process.exit(equal === compared ? 0 : 1)
