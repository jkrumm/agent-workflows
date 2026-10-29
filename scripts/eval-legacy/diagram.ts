#!/usr/bin/env bun
/**
 * The legacy arm of the `diagram` port's pre-registered rule (`docs/research/2026-10-29-wave7-ports.md` §diagram): runs
 * the recorded cases (`$AGW_EVAL_DIR/diagram/cases.jsonl`) against agent-gateway's `excalidraw_diagram`, as deployed,
 * through its job API (`POST /api/jobs`, then polling `GET /api/jobs/:id`, as `agw-legacy` does), scores each written
 * file with the same deterministic metrics the `diagram` scorer uses, and writes a JSON report next to the cases.
 *
 *   bun scripts/eval-legacy/diagram.ts [--runs 2] [--ids a,b] [--url http://127.0.0.1:7705] [--out report.json]
 *     [--usage <sessions.jsonl>] [--join <earlier report.json>]
 *
 * Spends the legacy route's money (a Haiku call per run). Cost is not in the job view: the report carries the job id
 * and the wall time; the cost of a run is joined afterwards from the gateway's session log (below).
 *
 * Cost: the job view carries none. After all runs the usage tracker's `agent-gateway-sessions.jsonl` is read, and a run
 * takes the `costUsd` of the `excalidraw-diagram` sessions that started between its submit and the poll that saw it
 * finish (runs are sequential, so the windows do not overlap; a retry inside one job adds a session and the costs are summed).
 * A log row that names the job (`jobId`) is joined on that id alone. Cases and runs go one at a time on purpose: the window
 * join only holds if no other diagram job of ours is in flight, and the summary says when it was used
 * (`foreignSessionRisk`: another caller's diagram job in the same window would be counted as ours). A run
 * with no such session, or whose session another run also claims, has `costUsd: null` and `costJoin` says why; the
 * summary counts how many runs joined. The log is flushed shortly after a job ends: run the join once the tracker has
 * caught up (a rerun with `--join <report.json>` redoes only the join).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { casesPath, evalDir, PlainCase, readCases } from '../../packages/eval/src/index.ts'
import { type DocumentMetrics, measureDocument } from '../../packages/host/src/workflows/diagram/metrics.ts'

const USAGE_LOG = join(homedir(), '.local', 'share', 'usage-tracker', 'agent-gateway-sessions.jsonl')
const POLL_MS = 2_000
const JOB_DEADLINE_MS = 10 * 60_000
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted'])

type Args = { runs: number; ids: string[] | null; url: string; out: string | null; usage: string; join: string | null }

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 2, ids: null, url: process.env.AGENT_GATEWAY_URL ?? 'http://127.0.0.1:7705', out: null, usage: USAGE_LOG, join: null }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--runs') args.runs = Number(value)
    else if (flag === '--ids') args.ids = value.split(',')
    else if (flag === '--url') args.url = value.replace(/\/+$/, '')
    else if (flag === '--out') args.out = value
    else if (flag === '--usage') args.usage = value
    else if (flag === '--join') args.join = value
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer')
  return args
}

type Job = { id: string; status: string; error: string | null }

async function api(url: string, path: string, body?: unknown): Promise<{ job: Job }> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = (await response.json()) as { ok?: boolean; job?: Job; error?: string }
  if (!response.ok || !data.ok || !data.job) throw new Error(data.error ?? `${path} answered ${response.status}`)
  return { job: data.job }
}

type RunRecord = {
  caseId: string
  run: number
  jobId: string | null
  status: string
  submittedAt: string
  finishedAt: string
  wallMs: number
  costUsd: number | null
  /** How the cost was joined: `sessions:<n>`, or why it was not (`unmatched`, `claimed twice`). */
  costJoin: string
  /** `jobId` (the log row names the job), `window` (time only: a foreign session could be mistaken for ours), `none`. */
  costJoinedBy?: 'jobId' | 'window' | 'none'
  models: string[]
  metrics: DocumentMetrics
  error?: string
}

async function runOnce(url: string, c: PlainCase, run: number): Promise<RunRecord> {
  const input = c.input as { brief: string; mode?: string; existing?: string }
  const mode = input.mode ?? 'create'
  // A directory of its own per run: no leftover file of an earlier run can be read as this run's result.
  const scratch = mkdtempSync(join(tmpdir(), 'agw-legacy-diagram-'))
  const outputPath = join(scratch, 'diagram.excalidraw')
  // Legacy extend reads the file at outputPath as its baseline.
  const seed = mode === 'extend' ? (input.existing ?? '') : null
  if (seed !== null) writeFileSync(outputPath, seed)
  const started = Date.now()
  const submittedAt = new Date(started).toISOString()
  const record = (patch: Partial<RunRecord>): RunRecord => ({
    caseId: c.id,
    run,
    jobId: null,
    status: 'error',
    submittedAt,
    finishedAt: new Date().toISOString(),
    wallMs: Date.now() - started,
    costUsd: null,
    costJoin: 'unmatched',
    models: [],
    metrics: measureDocument(null),
    ...patch,
  })
  try {
    const { job } = await api(url, '/api/jobs', { tool: 'excalidraw_diagram', params: { prompt: input.brief, outputPath, mode } })
    let current = job
    while (!TERMINAL.has(current.status)) {
      if (Date.now() - started > JOB_DEADLINE_MS) return record({ jobId: job.id, status: 'timeout', error: 'no result in 10 minutes' })
      await Bun.sleep(POLL_MS)
      current = (await api(url, `/api/jobs/${encodeURIComponent(job.id)}`)).job
    }
    if (current.status !== 'done') return record({ jobId: job.id, status: current.status, ...(current.error ? { error: current.error } : {}) })
    const written = readFileSync(outputPath, 'utf8')
    // An extend job that failed to write leaves the seed behind: byte-identical is a failure, not a diagram.
    if (seed !== null && written === seed) return record({ jobId: job.id, status: 'done', error: 'the job left the seeded file unchanged' })
    return record({ jobId: job.id, status: 'done', metrics: measureDocument(written) })
  } catch (error) {
    return record({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

type Session = { tsStart: number; costUsd: number; model: string; jobId?: string }

/** The `excalidraw-diagram` rows of the usage tracker's session log; a missing log is no sessions. */
function readSessions(path: string): Session[] {
  if (!existsSync(path)) return []
  const sessions: Session[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('excalidraw-diagram')) continue
    try {
      const row = JSON.parse(line) as { tool?: string; tsStart?: string; costUsd?: number; model?: string; jobId?: string }
      if (row.tool === 'excalidraw-diagram' && row.tsStart && typeof row.costUsd === 'number')
        sessions.push({ tsStart: Date.parse(row.tsStart), costUsd: row.costUsd, model: row.model ?? '?', ...(row.jobId ? { jobId: row.jobId } : {}) })
    } catch {}
  }
  return sessions
}

/**
 * Fills `costUsd`, `costJoin` and `models` of every run from the session log (see the header). A session row that names
 * a job is matched on the job id alone; only the rows without one fall back to the submit/finish window.
 */
function joinCosts(runs: RunRecord[], sessions: Session[]): void {
  const claims = new Map<Session, number>()
  const matched = runs.map((r) => {
    // Same host, same clock: a job's sessions start after its submit and before the poll that saw it finish.
    const from = Date.parse(r.submittedAt)
    const to = Date.parse(r.finishedAt)
    const byJob = r.jobId ? sessions.filter((s) => s.jobId === r.jobId) : []
    const own = byJob.length ? byJob : sessions.filter((s) => !s.jobId && s.tsStart >= from && s.tsStart < to)
    for (const s of own) claims.set(s, (claims.get(s) ?? 0) + 1)
    r.costJoinedBy = byJob.length ? 'jobId' : own.length ? 'window' : 'none'
    return own
  })
  runs.forEach((r, i) => {
    const own = matched[i] ?? []
    if (own.length === 0) Object.assign(r, { costUsd: null, costJoin: 'unmatched', models: [] })
    else if (own.some((s) => (claims.get(s) ?? 0) > 1)) Object.assign(r, { costUsd: null, costJoin: 'claimed twice', models: [] })
    else Object.assign(r, { costUsd: own.reduce((sum, s) => sum + s.costUsd, 0), costJoin: `sessions:${own.length}`, models: [...new Set(own.map((s) => s.model))] })
  })
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) + (sorted[Math.ceil((sorted.length - 1) / 2)] ?? 0)) / 2 : null
}

/**
 * The numbers of the rule's table. The valid rate counts failures; every other mean is over the valid runs only, as the
 * `diagram` scorer does, so a failed run never pulls a mean down. Cost is over the runs whose cost joined.
 */
function summarize(runs: RunRecord[]) {
  const valid = runs.flatMap((r) => (r.metrics.valid ? [r.metrics] : []))
  const costs = runs.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))
  return {
    runs: runs.length,
    validRate: runs.length ? valid.length / runs.length : null,
    meanBoundArrowShare: mean(valid.flatMap((m) => (m.boundArrowShare === null ? [] : [m.boundArrowShare]))),
    meanOverlaps: mean(valid.map((m) => m.overlaps)),
    meanTextOverflow: mean(valid.map((m) => m.textOverflow)),
    meanElementCount: mean(valid.map((m) => m.elementCount)),
    medianWallMs: median(runs.map((r) => r.wallMs)),
    medianCostUsd: median(costs),
    costJoined: `${costs.length}/${runs.length}`,
    // A window join cannot tell our session from another caller's diagram job that started in the same window, and a
    // run with more than one session is where that (or a retry inside the job) shows. Run the arm on an idle gateway.
    costJoinedBy: { jobId: runs.filter((r) => r.costJoinedBy === 'jobId').length, window: runs.filter((r) => r.costJoinedBy === 'window').length },
    foreignSessionRisk: runs.some((r) => r.costJoinedBy === 'window'),
    multiSessionRuns: runs.filter((r) => r.costJoin.startsWith('sessions:') && r.costJoin !== 'sessions:1').length,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.join) {
    const report = JSON.parse(readFileSync(args.join, 'utf8')) as { runs: RunRecord[]; summary: unknown }
    joinCosts(report.runs, readSessions(args.usage))
    report.summary = summarize(report.runs)
    writeFileSync(args.join, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ report: args.join, summary: report.summary }, null, 2))
    return
  }
  const cases = readCases(casesPath('diagram'), PlainCase).filter((c) => !args.ids || args.ids.includes(c.id))
  if (cases.length === 0) throw new Error(`no cases in ${casesPath('diagram')}`)
  const out = args.out ?? join(evalDir(), 'diagram', `legacy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const runs: RunRecord[] = []
  for (const c of cases)
    for (let run = 1; run <= args.runs; run++) {
      const record = await runOnce(args.url, c, run)
      runs.push(record)
      const m = record.metrics
      console.error(`${c.id} #${run}: ${record.status} ${record.wallMs} ms${m.valid ? ` ${m.elementCount} elements` : record.error ? ` (${record.error})` : ''}`)
    }
  joinCosts(runs, readSessions(args.usage))
  const report = { arm: 'legacy', tool: 'excalidraw_diagram', at: new Date().toISOString(), url: 'local gateway', summary: summarize(runs), runs }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ report: out, summary: report.summary }, null, 2))
}

await main()
