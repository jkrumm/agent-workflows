import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  controlCase,
  type GtBugCase,
  GtCandidate,
  GtCase,
  type GtControlCase,
  GtLabelRecord,
  GtRejected,
  type GtFile,
  acceptRecord,
  gtPath,
  readCases,
  writeCases,
} from '@agent-workflows/eval'
import type { z } from 'zod'

type Env = Record<string, string | undefined>
type Control = z.infer<typeof GtControlCase>
type Rejected = z.infer<typeof GtRejected>
type Case = z.infer<typeof GtCase>

/** A `review-gt` file as validated records; a file that does not exist yet has none. */
export function readRecords<T extends z.ZodType>(file: GtFile, schema: T, env: Env): z.infer<T>[] {
  const path = gtPath(file, env)
  return existsSync(path) ? readCases(path, schema) : []
}

/** Appends one record (mode 0600): the labels file is written as each candidate finishes, so a crash keeps the rest. */
export function appendLabel(record: GtLabelRecord, env: Env): void {
  const path = gtPath('labels.jsonl', env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify(GtLabelRecord.parse(record))}\n`, { mode: 0o600 })
}

export function writeReport(report: unknown, env: Env): void {
  const path = gtPath('report.json', env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** The labels of one labeler version: the latest record per candidate (a relabelled error comes later in the file). */
export function latestLabels(env: Env, labelerVersion: string): Map<string, GtLabelRecord> {
  const latest = new Map<string, GtLabelRecord>()
  for (const record of readRecords('labels.jsonl', GtLabelRecord, env)) {
    if (record.labelerVersion === labelerVersion) latest.set(record.candidateId, record)
  }
  return latest
}

export const hasSeatError = (record: GtLabelRecord) => 'error' in record.a || 'error' in record.b

export type CaseSummary = {
  /** Candidates with a label record under the current labeler version. */
  labelled: number
  accepted: number
  rejected: { total: number; byReason: Record<string, number> }
  /** Accepted bug cases by bug class. */
  bugClasses: Record<string, number>
  cases: { dev: { bug: number; control: number }; test: { bug: number; control: number } }
}

/**
 * Rebuilds `cases.jsonl` (the accepted bugs, then the controls) and `rejected.jsonl` from every label record of the
 * current labeler version. `controls` are the mine's; absent, the controls already in `cases.jsonl` stay. A candidate
 * that left `candidates.jsonl` (a filter change) has no case.
 */
export function rebuildCases(options: { env: Env; labelerVersion: string; controls?: Control[] }): CaseSummary {
  const { env } = options
  const candidates = new Map(readRecords('candidates.jsonl', GtCandidate, env).map((c) => [c.id, c]))
  const controls =
    options.controls ?? readRecords('cases.jsonl', GtCase, env).filter((c): c is Control => c.kind === 'control')
  const labels = latestLabels(env, options.labelerVersion)
  const bugs: z.infer<typeof GtBugCase>[] = []
  const rejected: Rejected[] = []
  for (const [id, record] of labels) {
    const candidate = candidates.get(id)
    if (!candidate) continue
    const verdict = acceptRecord(record, candidate)
    if (verdict.accepted) bugs.push(verdict.case)
    else rejected.push(verdict.rejected)
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  bugs.sort(byId)
  rejected.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0))
  controls.sort(byId)
  const cases: Case[] = [...bugs, ...controls]
  writeCases(gtPath('cases.jsonl', env), GtCase, cases)
  writeCases(gtPath('rejected.jsonl', env), GtRejected, rejected)

  const summary: CaseSummary = {
    labelled: [...labels.keys()].filter((id) => candidates.has(id)).length,
    accepted: bugs.length,
    rejected: { total: rejected.length, byReason: {} },
    bugClasses: {},
    cases: { dev: { bug: 0, control: 0 }, test: { bug: 0, control: 0 } },
  }
  for (const r of rejected) summary.rejected.byReason[r.reason] = (summary.rejected.byReason[r.reason] ?? 0) + 1
  for (const c of cases) summary.cases[c.split][c.kind]++
  for (const b of bugs) summary.bugClasses[b.bug.bugClass] = (summary.bugClasses[b.bug.bugClass] ?? 0) + 1
  return summary
}

/** Writes the mine's candidates whole. */
export function writeCandidates(candidates: GtCandidate[], env: Env): void {
  writeCases(gtPath('candidates.jsonl', env), GtCandidate, candidates)
}

export const controlCases = (controls: Parameters<typeof controlCase>[0][]): Control[] => controls.map(controlCase)
