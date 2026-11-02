import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  controlCase,
  type GtBugCase,
  GtCandidate,
  GtCase,
  type GtControlCase,
  type GtFile,
  GtLabelRecord,
  GtRejected,
  acceptRecord,
  gtPath,
  writeCases,
  writeFileAtomic,
} from '@agent-workflows/eval'
import { WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'

type Env = Record<string, string | undefined>
type Control = z.infer<typeof GtControlCase>
type Rejected = z.infer<typeof GtRejected>
type Case = z.infer<typeof GtCase>
/** Where a skipped line is reported: `Logger.warn`. */
export type Warn = (message: string, meta?: Record<string, unknown>) => void

const OwnerFile = z.object({ emails: z.array(z.string().min(3)).min(1) }).strict()

/**
 * The owner's author emails: `AGW_EVAL_OWNER_EMAILS` (comma separated) over `$AGW_EVAL_DIR/review-gt/owner.json`
 * (`{ "emails": [...] }`). They are private, so they live in neither the source nor the tests; mining refuses without them.
 */
export function readOwnerEmails(env: Env): string[] {
  const fromEnv = env.AGW_EVAL_OWNER_EMAILS?.split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  if (fromEnv?.length) return fromEnv
  const path = join(dirname(gtPath('report.json', env)), 'owner.json')
  if (!existsSync(path)) {
    throw new WorkflowError(
      'invalid_input',
      `no owner emails: set AGW_EVAL_OWNER_EMAILS (comma separated) or write {"emails":["<author email>"]} to ${path}`,
    )
  }
  const parsed = OwnerFile.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) throw new WorkflowError('invalid_input', `${path}: ${z.prettifyError(parsed.error)}`)
  return parsed.data.emails
}

/**
 * A `review-gt` file as validated records; a file that does not exist yet has none. A line that is not JSON (a torn
 * write: a crash mid-append) is skipped with a warning naming `file:line`; a line that is JSON but not a record is
 * corruption and throws.
 */
export function readRecords<T extends z.ZodType>(file: GtFile, schema: T, env: Env, warn: Warn): z.infer<T>[] {
  const path = gtPath(file, env)
  if (!existsSync(path)) return []
  const records: z.infer<T>[] = []
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (text.trim() === '') return
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        warn(`${basename(path)}:${index + 1}: unreadable line skipped (a torn write?)`)
        return
      }
      const parsed = schema.safeParse(json)
      if (!parsed.success) throw new Error(`${path}:${index + 1}: ${z.prettifyError(parsed.error)}`)
      records.push(parsed.data)
    })
  return records
}

const endsWithNewline = (path: string) => {
  const size = statSync(path).size
  if (size === 0) return true
  const fd = openSync(path, 'r')
  try {
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Appends one record (mode 0600): the labels file is written as each candidate finishes, so a crash keeps the rest.
 * A file whose last line was torn gets a line break first, so the new record is a line of its own.
 */
export function appendLabel(record: GtLabelRecord, env: Env): void {
  const path = gtPath('labels.jsonl', env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lead = existsSync(path) && !endsWithNewline(path) ? '\n' : ''
  appendFileSync(path, `${lead}${JSON.stringify(GtLabelRecord.parse(record))}\n`, { mode: 0o600 })
}

/** `report.json`, atomically. */
export function writeReport(report: unknown, env: Env): void {
  writeFileAtomic(gtPath('report.json', env), `${JSON.stringify(report, null, 2)}\n`)
}

/** The labels of one labeler version: the latest record per candidate (a relabelled error comes later in the file). */
export function latestLabels(env: Env, labelerVersion: string, warn: Warn): Map<string, GtLabelRecord> {
  const latest = new Map<string, GtLabelRecord>()
  for (const record of readRecords('labels.jsonl', GtLabelRecord, env, warn)) {
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
export function rebuildCases(options: {
  env: Env
  labelerVersion: string
  warn: Warn
  controls?: Control[]
}): CaseSummary {
  const { env, warn } = options
  const candidates = new Map(readRecords('candidates.jsonl', GtCandidate, env, warn).map((c) => [c.id, c]))
  const controls =
    options.controls ?? readRecords('cases.jsonl', GtCase, env, warn).filter((c): c is Control => c.kind === 'control')
  const labels = latestLabels(env, options.labelerVersion, warn)
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
