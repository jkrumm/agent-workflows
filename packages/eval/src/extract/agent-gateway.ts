#!/usr/bin/env bun
// Builds the review and check eval sets (concept §6) from agent-gateway's recorded runs: the frozen
// 2026-10-19 corpus and the legacy jobs.db. Read-only on every source: jobs.db opens readonly, git runs
// with GIT_OPTIONAL_LOCKS=0, usage logs are only read. The cases hold private code, so they are written
// to `casesPath(...)` and never into the repo.
//
//   bun packages/eval/src/extract/agent-gateway.ts [--dry-run]
//
// Sources and output paths can be overridden by env (tests use fixtures): AGW_GATEWAY_JOBS_DB,
// AGW_GATEWAY_CORPUS, AGW_USAGE_DIR; the output dir by AGW_EVAL_DIR (see cases.ts).

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  casesPath,
  CheckCase,
  CheckStepName,
  Depth,
  type Finding,
  ReviewCase,
  ReviewOutcome,
  writeCases,
} from '../cases.ts'

export type SkipReason =
  | 'repo-outside-home'
  | 'repo-unmapped'
  | 'repo-missing'
  | 'params-unparseable'
  | 'no-result'
  | 'result-unparseable'
  | 'step-unknown'
  | 'uncommitted'
  | 'branch-scope'
  | 'scope-unresolvable'
  | 'pr-ref-missing'
  | 'no-merge-base'
  | 'diff-failed'
  | 'empty-diff'
  | 'no-base-commit'
  | 'schema-invalid'

export type Mapped<T> = { value: T } | { skip: SkipReason }

const skip = (reason: SkipReason): { skip: SkipReason } => ({ skip: reason })

export interface Span {
  id: string
  startMs: number
  endMs: number
}

export interface IuRow {
  tsMs: number
  costUsd: number
}

export interface Usage {
  /** Summed `costUsd` per legacy job id, only for jobs with at least one numeric cost row. */
  sessions: Map<string, number>
  iu: IuRow[]
}

export interface Spend {
  costUsd: number | null
  costExact: boolean
  wallMs: number | null
}

/** Review tools whose IU-log rows carry no job id; they are matched to a job by time window. */
export const IU_REVIEW_TOOLS = new Set(['review:router', 'review:adversary', 'review_ocr'])
const PIPELINE_FILE = '(review pipeline)'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const unique = (values: string[]): string[] => [...new Set(values)]

function parseJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The job's repo as `SourceRoot/<name>` or `IuRoot/<name>`, from a cwd under `home`. A worktree
 *  (`<repo>/.claude/worktrees/<name>`) maps to its repo. Anything else is skipped. */
export function repoOf(cwd: string, home: string): Mapped<string> {
  const prefix = home.endsWith('/') ? home : `${home}/`
  if (!cwd.startsWith(prefix)) return skip('repo-outside-home')
  let rel = cwd.slice(prefix.length).replace(/\/+$/, '')
  const worktree = rel.indexOf('/.claude/worktrees/')
  if (worktree !== -1) rel = rel.slice(0, worktree)
  const [root, name, ...rest] = rel.split('/')
  if (rest.length > 0 || !name || (root !== 'SourceRoot' && root !== 'IuRoot')) return skip('repo-unmapped')
  return { value: `${root}/${name}` }
}

/** The legacy call's input: its params minus `cwd` and `caller`. */
export function inputOf(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'cwd' && key !== 'caller'))
}

type DepthValue = NonNullable<ReviewCase['legacy']['depth']>

export function depthOf(params: Record<string, unknown>, result: Record<string, unknown>): DepthValue | null {
  for (const source of [params.depth, result.depth]) {
    const parsed = Depth.safeParse(source)
    if (parsed.success) return parsed.data
  }
  return null
}

function legacyFindings(items: unknown, severity: Finding['severity']): Finding[] {
  if (!Array.isArray(items)) return []
  return items.filter(isRecord).map((item) => ({
    severity,
    file: String(item.file ?? ''),
    ...(typeof item.line === 'number' ? { line: item.line } : {}),
    message: String(item.message ?? ''),
    angle: String(item.angle ?? ''),
  }))
}

/** Reviewers that failed in a pipeline discussion: its `angle`, plus the reviewer a message opens with
 *  (`senior-dev session failed: …`). */
function failedNames(discussion: Record<string, unknown>): string[] {
  const message = String(discussion.message ?? '')
  const named = /^([a-z][a-z-]*) session\b/.exec(message)?.[1]
  return [String(discussion.angle ?? ''), named ?? ''].filter(Boolean)
}

export interface LegacyReview {
  outcome: ReviewCase['legacy']['outcome']
  depth: DepthValue | null
  findings: Finding[]
  testGaps: string[]
  failedAngles: string[]
}

/** A legacy review result (`REVIEW_OUTPUT` v2) as the review case's `legacy` fields. */
export function legacyReview(result: unknown, params: Record<string, unknown>): Mapped<LegacyReview> {
  if (result === null || result === undefined) return skip('no-result')
  if (!isRecord(result)) return skip('result-unparseable')
  const outcome = ReviewOutcome.safeParse(result.outcome)
  if (!outcome.success) return skip('result-unparseable')
  const discussions = Array.isArray(result.discussions) ? result.discussions.filter(isRecord) : []
  return {
    value: {
      outcome: outcome.data,
      depth: depthOf(params, result),
      findings: [
        ...legacyFindings(result.blocking, 'blocking'),
        ...legacyFindings(result.improvements, 'improvement'),
        ...legacyFindings(discussions, 'discussion'),
      ],
      testGaps: stringsOf(result.testGaps),
      failedAngles: unique(discussions.filter((d) => d.file === PIPELINE_FILE).flatMap(failedNames)),
    },
  }
}

export interface LegacyCheck {
  passed: boolean
  steps: CheckCase['legacy']['steps']
}

export function legacyCheck(result: unknown): Mapped<LegacyCheck> {
  if (result === null || result === undefined) return skip('no-result')
  if (!isRecord(result) || typeof result.passed !== 'boolean' || !Array.isArray(result.steps)) {
    return skip('result-unparseable')
  }
  const steps: CheckCase['legacy']['steps'] = []
  for (const step of result.steps) {
    if (!isRecord(step) || typeof step.passed !== 'boolean') return skip('result-unparseable')
    const name = CheckStepName.safeParse(step.name)
    if (!name.success) return skip('step-unknown')
    steps.push({
      name: name.data,
      passed: step.passed,
      ...(Array.isArray(step.errors) ? { errors: stringsOf(step.errors) } : {}),
    })
  }
  return { value: { passed: result.passed, steps } }
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

/** Reads both usage logs. A live-appended log can end mid-line, so unparseable lines are dropped. */
export function parseUsage(sessionsJsonl: string, iuJsonl: string): Usage {
  const sessions = new Map<string, number>()
  for (const line of lines(sessionsJsonl)) {
    const row = parseJson(line)
    if (!isRecord(row) || typeof row.jobId !== 'string' || typeof row.costUsd !== 'number') continue
    sessions.set(row.jobId, (sessions.get(row.jobId) ?? 0) + row.costUsd)
  }
  const iu: IuRow[] = []
  for (const line of lines(iuJsonl)) {
    const row = parseJson(line)
    if (!isRecord(row) || typeof row.tool !== 'string' || !IU_REVIEW_TOOLS.has(row.tool)) continue
    const tsMs = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN
    if (Number.isNaN(tsMs)) continue
    iu.push({ tsMs, costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : 0 })
  }
  return { sessions, iu }
}

export interface CostInput {
  id: string
  span: Span | null
  usage: Usage
  /** Every review job's window, including this one: an IU row counts only when it was the sole review running. */
  reviewSpans: Span[]
  /** False for check jobs: no IU call is part of a check. */
  iuApplies: boolean
}

/** Session cost of a job, plus the IU rows in its window that no other review job overlapped.
 *  `costExact` is false whenever an IU row was matched or excluded, or the window is unknown. */
export function costOf(input: CostInput): Pick<Spend, 'costUsd' | 'costExact'> {
  let costExact = true
  let iuCost = 0
  const { span } = input
  if (input.iuApplies && !span) costExact = false
  for (const row of input.iuApplies && span ? input.usage.iu : []) {
    if (!span || row.tsMs < span.startMs || row.tsMs > span.endMs) continue
    costExact = false
    const running = input.reviewSpans.filter((s) => s.startMs <= row.tsMs && row.tsMs <= s.endMs).length
    if (running === 1) iuCost += row.costUsd
  }
  const session = input.usage.sessions.get(input.id)
  const costUsd = session === undefined ? null : Math.round((session + iuCost) * 1e6) / 1e6
  return { costUsd, costExact }
}

export function wallOf(span: Span | null): number | null {
  return span && span.endMs >= span.startMs ? span.endMs - span.startMs : null
}

const isoOf = (ms: number): string => new Date(ms).toISOString()
const HEX_SHA = /^[0-9a-f]{7,40}$/

export interface Sources {
  home: string
  jobsDb: string
  corpus: string
  usageDir: string
}

export function sourcesFromEnv(env: Record<string, string | undefined> = process.env, home = homedir()): Sources {
  const share = join(home, '.local', 'share')
  return {
    home,
    jobsDb: env.AGW_GATEWAY_JOBS_DB?.trim() || join(share, 'agent-gateway', 'jobs.db'),
    corpus:
      env.AGW_GATEWAY_CORPUS?.trim() ||
      join(share, 'agent-gateway', 'bench', 'review-corpus-2026-10-19', 'corpus.jsonl'),
    usageDir: env.AGW_USAGE_DIR?.trim() || join(share, 'usage-tracker'),
  }
}

export interface Tally {
  written: number
  deduped: number
  skipped: Partial<Record<SkipReason, number>>
}

export interface Extraction {
  review: ReviewCase[]
  check: CheckCase[]
  tally: { review: Tally; check: Tally }
  repos: Set<string>
}

interface CorpusLine {
  jobId: string
  createdAt: number
  repo: string
  params: Record<string, unknown>
  baseSha: string
  headSha: string
  diff: string
  result: unknown
}

interface JobRow {
  id: string
  tool: string
  params: string
  status: string
  result: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface Ctx {
  home: string
  usage: Usage
  windows: Map<string, Span>
  reviewSpans: Span[]
}

function git(dir: string, args: string[]): string | null {
  const run = Bun.spawnSync(['git', '-c', 'core.pager=cat', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 60_000,
  })
  return run.exitCode === 0 ? run.stdout.toString() : null
}

function commitOf(dir: string, ref: string): string | null {
  return git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])?.trim() || null
}

function mergeBaseOf(dir: string, head: string): string | null {
  for (const trunk of ['master', 'main']) {
    const base = git(dir, ['merge-base', trunk, head])?.trim()
    if (base) return base
  }
  return null
}

interface RebuiltDiff {
  diff: string
  baseSha: string
  headSha: string
  baseInferred: boolean
}

function diffBetween(dir: string, base: string, head: string, baseInferred: boolean): Mapped<RebuiltDiff> {
  const diff = git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, head])
  if (diff === null) return skip('diff-failed')
  if (!diff.trim()) return skip('empty-diff')
  return { value: { diff, baseSha: base, headSha: head, baseInferred } }
}

/** The diff a legacy review saw, rebuilt from git the way scripts/replay-depth.ts does it. Uncommitted
 *  scopes are skipped (the working tree is gone); a PR diffs its merge-base with the local PR ref. */
function rebuildReviewDiff(params: Record<string, unknown>, dir: string): Mapped<RebuiltDiff> {
  if (typeof params.pr === 'number') {
    const head = commitOf(dir, `refs/pull/${params.pr}/head`)
    if (!head) return skip('pr-ref-missing')
    const base = mergeBaseOf(dir, head)
    if (!base) return skip('no-merge-base')
    return diffBetween(dir, base, head, true)
  }
  if (typeof params.branch === 'string') return skip('branch-scope')
  const scope = typeof params.scope === 'string' ? params.scope : 'uncommitted'
  if (scope === 'uncommitted') return skip('uncommitted')
  if (scope === 'head') {
    // Legacy ran `git show HEAD`: the same change as HEAD^..HEAD, without the commit header.
    const base = commitOf(dir, 'HEAD^')
    const head = commitOf(dir, 'HEAD')
    return base && head ? diffBetween(dir, base, head, true) : skip('scope-unresolvable')
  }
  if (scope.includes('..')) {
    const [left = '', right = ''] = scope.split('..')
    const base = commitOf(dir, left)
    const head = commitOf(dir, right)
    if (!base || !head) return skip('scope-unresolvable')
    return diffBetween(dir, base, head, !HEX_SHA.test(left))
  }
  // A bare ref means the range up to HEAD (scopeDiffArgs).
  const base = commitOf(dir, scope)
  const head = commitOf(dir, 'HEAD')
  return base && head ? diffBetween(dir, base, head, true) : skip('scope-unresolvable')
}

/** The last commit on HEAD before the job was created. `@<unix seconds>` is git's epoch form for --before. */
function inferBase(dir: string, createdAtMs: number): string | null {
  return git(dir, ['rev-list', '-1', `--before=@${Math.floor(createdAtMs / 1000)}`, 'HEAD'])?.trim() || null
}

function repoDirOf(home: string, repo: string): string {
  return join(home, repo)
}

function reviewFromCorpus(line: CorpusLine, ctx: Ctx): Mapped<ReviewCase> {
  const repo = repoOf(typeof line.repo === 'string' ? line.repo : cwdOf(line.params), ctx.home)
  if ('skip' in repo) return repo
  const legacy = legacyReview(line.result, line.params)
  if ('skip' in legacy) return legacy
  if (!line.diff.trim()) return skip('empty-diff')
  // The corpus records a short head sha for some runs; expand it read-only in the repo.
  const headSha = line.headSha.length === 40 ? line.headSha : commitOf(repoDirOf(ctx.home, repo.value), line.headSha)
  if (!headSha) return skip('scope-unresolvable')
  const span = ctx.windows.get(line.jobId) ?? null
  const spend = costOf({ id: line.jobId, span, usage: ctx.usage, reviewSpans: ctx.reviewSpans, iuApplies: true })
  return {
    value: {
      id: line.jobId,
      source: 'corpus-2026-10-19',
      createdAt: isoOf(line.createdAt),
      repo: repo.value,
      input: inputOf(line.params),
      baseSha: line.baseSha,
      headSha,
      baseInferred: false,
      diff: line.diff,
      legacy: { ...legacy.value, ...spend, wallMs: wallOf(span) },
    },
  }
}

function reviewFromJob(row: JobRow, ctx: Ctx): Mapped<ReviewCase> {
  const params = parseJson(row.params)
  if (!isRecord(params)) return skip('params-unparseable')
  const repo = repoOf(cwdOf(params), ctx.home)
  if ('skip' in repo) return repo
  const dir = repoDirOf(ctx.home, repo.value)
  if (!existsSync(dir)) return skip('repo-missing')
  const legacy = legacyReview(row.result === null ? null : parseJson(row.result), params)
  if ('skip' in legacy) return legacy
  const rebuilt = rebuildReviewDiff(params, dir)
  if ('skip' in rebuilt) return rebuilt
  const span = ctx.windows.get(row.id) ?? null
  const spend = costOf({ id: row.id, span, usage: ctx.usage, reviewSpans: ctx.reviewSpans, iuApplies: true })
  return {
    value: {
      id: row.id,
      source: 'jobs-db',
      createdAt: isoOf(row.created_at),
      repo: repo.value,
      input: inputOf(params),
      baseSha: rebuilt.value.baseSha,
      headSha: rebuilt.value.headSha,
      baseInferred: rebuilt.value.baseInferred,
      diff: rebuilt.value.diff,
      legacy: { ...legacy.value, ...spend, wallMs: wallOf(span) },
    },
  }
}

/** Check jobs record no patch: the uncommitted state is gone, so the base is inferred and the case has none. */
function checkFromJob(row: JobRow, ctx: Ctx): Mapped<CheckCase> {
  const params = parseJson(row.params)
  if (!isRecord(params)) return skip('params-unparseable')
  const repo = repoOf(cwdOf(params), ctx.home)
  if ('skip' in repo) return repo
  const dir = repoDirOf(ctx.home, repo.value)
  if (!existsSync(dir)) return skip('repo-missing')
  const legacy = legacyCheck(row.result === null ? null : parseJson(row.result))
  if ('skip' in legacy) return legacy
  const baseSha = inferBase(dir, row.created_at)
  if (!baseSha) return skip('no-base-commit')
  const span = ctx.windows.get(row.id) ?? null
  const spend = costOf({ id: row.id, span, usage: ctx.usage, reviewSpans: ctx.reviewSpans, iuApplies: false })
  return {
    value: {
      id: row.id,
      source: 'jobs-db',
      createdAt: isoOf(row.created_at),
      repo: repo.value,
      input: inputOf(params),
      baseSha,
      baseInferred: true,
      legacy: { ...legacy.value, ...spend, wallMs: wallOf(span) },
    },
  }
}

function cwdOf(params: Record<string, unknown>): string {
  return typeof params.cwd === 'string' ? params.cwd : ''
}

function emptyTally(): Tally {
  return { written: 0, deduped: 0, skipped: {} }
}

function accept<T extends { repo: string }>(
  tally: Tally,
  cases: T[],
  mapped: Mapped<T>,
  parse: (value: T) => boolean,
): void {
  if ('skip' in mapped) {
    tally.skipped[mapped.skip] = (tally.skipped[mapped.skip] ?? 0) + 1
    return
  }
  if (!parse(mapped.value)) {
    tally.skipped['schema-invalid'] = (tally.skipped['schema-invalid'] ?? 0) + 1
    return
  }
  tally.written++
  cases.push(mapped.value)
}

/** Reads every source and maps it to review and check cases. Writes nothing. */
export function extractAll(sources: Sources): Extraction {
  const usage = parseUsage(
    readFileSync(join(sources.usageDir, 'agent-gateway-sessions.jsonl'), 'utf8'),
    readFileSync(join(sources.usageDir, 'agent-gateway-iu.jsonl'), 'utf8'),
  )
  const corpus = readFileSync(sources.corpus, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusLine)

  const db = new Database(sources.jobsDb, { readonly: true })
  let jobs: JobRow[]
  const windows = new Map<string, Span>()
  const reviewById = new Map<string, Span>()
  try {
    const stats = db
      .query(
        'SELECT id, tool, started_at, finished_at FROM job_stats WHERE started_at IS NOT NULL AND finished_at IS NOT NULL',
      )
      .all() as { id: string; tool: string; started_at: number; finished_at: number }[]
    for (const row of stats) {
      const span = { id: row.id, startMs: row.started_at, endMs: row.finished_at }
      windows.set(row.id, span)
      if (row.tool === 'review') reviewById.set(row.id, span)
    }
    jobs = db
      .query(
        "SELECT id, tool, params, status, result, created_at, started_at, finished_at FROM jobs WHERE tool IN ('review', 'check')",
      )
      .all() as JobRow[]
  } finally {
    db.close()
  }
  for (const row of jobs) {
    if (row.started_at === null || row.finished_at === null) continue
    const span = { id: row.id, startMs: row.started_at, endMs: row.finished_at }
    windows.set(row.id, span)
    if (row.tool === 'review') reviewById.set(row.id, span)
  }

  const ctx: Ctx = { home: sources.home, usage, windows, reviewSpans: [...reviewById.values()] }
  const review: ReviewCase[] = []
  const check: CheckCase[] = []
  const reviewTally = emptyTally()
  const checkTally = emptyTally()
  const seen = new Set<string>()

  for (const line of corpus) {
    seen.add(line.jobId)
    accept(reviewTally, review, reviewFromCorpus(line, ctx), (c) => ReviewCase.safeParse(c).success)
  }
  for (const row of jobs) {
    if (row.status !== 'done') continue
    if (row.tool === 'review') {
      if (seen.has(row.id)) {
        reviewTally.deduped++
        continue
      }
      seen.add(row.id)
      accept(reviewTally, review, reviewFromJob(row, ctx), (c) => ReviewCase.safeParse(c).success)
    }
    if (row.tool === 'check') {
      accept(checkTally, check, checkFromJob(row, ctx), (c) => CheckCase.safeParse(c).success)
    }
  }

  review.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  check.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const repos = new Set([...review, ...check].map((c) => c.repo))
  return { review, check, tally: { review: reviewTally, check: checkTally }, repos }
}

function describe(
  name: string,
  tally: Tally,
  cost: Spend[],
  outcomes: ReviewCase['legacy']['outcome'][] | null,
): string[] {
  const skipped = Object.entries(tally.skipped)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ')
  const nullCost = cost.filter((c) => c.costUsd === null).length
  const exact = cost.filter((c) => c.costUsd !== null && c.costExact).length
  const approx = cost.filter((c) => c.costUsd !== null && !c.costExact).length
  const total = cost.reduce((sum, c) => sum + (c.costUsd ?? 0), 0)
  const out = [
    `${name}: ${tally.written} written, ${tally.deduped} deduped against corpus, skipped: ${skipped || 'none'}`,
    `${name} cost: exact ${exact}, approximate ${approx}, null ${nullCost}, total $${total.toFixed(2)}`,
  ]
  if (outcomes) {
    const counts = (['clean', 'actionable', 'needs-human'] as const).map(
      (o) => `${o} ${outcomes.filter((x) => x === o).length}`,
    )
    out.push(`review outcomes: ${counts.join(', ')}`)
  }
  return out
}

export async function main(argv: string[] = process.argv.slice(2), env = process.env): Promise<void> {
  const dryRun = argv.includes('--dry-run')
  const extraction = extractAll(sourcesFromEnv(env))
  const lines = [
    ...describe(
      'review',
      extraction.tally.review,
      extraction.review.map((c) => c.legacy),
      extraction.review.map((c) => c.legacy.outcome),
    ),
    ...describe(
      'check',
      extraction.tally.check,
      extraction.check.map((c) => c.legacy),
      null,
    ),
    `repos: ${extraction.repos.size}`,
  ]
  console.log(lines.join('\n'))
  if (dryRun) {
    console.log('dry run: nothing written')
    return
  }
  writeCases(casesPath('review', env), ReviewCase, extraction.review)
  writeCases(casesPath('check', env), CheckCase, extraction.check)
  console.log('written to the eval dir (review/cases.jsonl, check/cases.jsonl)')
}

if (import.meta.main) {
  await main()
}
