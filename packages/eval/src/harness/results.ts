import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'
import type { Depth, ReviewOutcome } from '../cases.ts'
import type { SkipReason } from './materialize.ts'
import type { Located } from './ports.ts'

/** `ok` ran both sides; `skipped` never reached a side (counted, never dropped); `error` a side failed. */
export type CaseStatus = 'ok' | 'skipped' | 'error'

interface CaseBase {
  id: string
  status: CaseStatus
  /** Private: may name an `IuRoot` repo. Never in the aggregate section. */
  repo: string
  /** `new_failed`: the new side failed (a miss in the verdict); `harness_failed`: the harness itself (judge, git, matcher). */
  reason?: SkipReason | 'new_failed' | 'harness_failed'
  detail?: string
}

export interface ReviewSide {
  outcome: z.infer<typeof ReviewOutcome>
  blocking: number
  improvements: number
  failedAngles: number
  costUsd: number | null
  costExact: boolean
  wallMs: number | null
  runId?: string
}

export interface MatchCounts {
  reference: number
  matched: number
  judged: number
  unsure: number
}

export interface ReviewCaseResult extends CaseBase {
  workflow: 'review'
  /** The depth the new side was asked for; `null` lets its router choose. */
  depth: z.infer<typeof Depth> | null
  legacy: ReviewSide
  new?: ReviewSide
  /** New blocking vs the recorded legacy blocking (the reference). */
  match?: MatchCounts & { newOnly: number }
  /** The legacy rerun and its agreement with the recorded run: legacy's own noise floor. */
  rerun?: ReviewSide & { self: MatchCounts }
  rerunError?: string
  /** Private: legacy blocking findings the new side missed, and new-only blocking findings. */
  missed?: Located[]
  newOnly?: Located[]
}

export interface CheckSide {
  passed: boolean
  steps: { name: string; passed: boolean }[]
  costUsd: number | null
  costExact: boolean
  wallMs: number | null
  runId?: string
}

export interface CheckCaseResult extends CaseBase {
  workflow: 'check'
  legacy: CheckSide
  new?: CheckSide
  rerun?: CheckSide
  rerunError?: string
}

export type CaseResult = ReviewCaseResult | CheckCaseResult

/** Appends one case result (the file is the resume point; mode 0600: it holds private findings). */
export function appendResult(path: string, result: CaseResult): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lead = endsTorn(path) ? '\n' : ''
  appendFileSync(path, `${lead}${JSON.stringify(result)}\n`, { mode: 0o600 })
}

/** A killed run can leave a last line without its newline; the next result must not be glued onto it. */
function endsTorn(path: string): boolean {
  if (!existsSync(path)) return false
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size === 0) return false
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

/** The results so far; a torn last line (a killed run) is ignored. A later line for the same id wins. */
export function readResults<T extends CaseResult>(path: string): T[] {
  if (!existsSync(path)) return []
  const byId = new Map<string, T>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const result = JSON.parse(line) as T
      byId.set(result.id, result)
    } catch {}
  }
  return [...byId.values()]
}

/** A case is finished once it ran or was skipped; an `error` case runs again on resume. */
export const finishedIds = (results: CaseResult[]) =>
  new Set(results.filter((r) => r.status !== 'error').map((r) => r.id))
