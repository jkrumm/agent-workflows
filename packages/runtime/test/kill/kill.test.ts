// Kill harness (spike S1, kept as a regression test against the real runtime). Worker subprocesses SIGKILL
// themselves at every step boundary (b-*) and mid-step (m-*), SIGTERM-deploy onto changed code, and drive 25
// concurrent runs through a kill. The ledger proves: every run done, 0 completed steps re-run, each effect
// inserted exactly once, each agent session prompted exactly once.
import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { Runtime } from '../../src/index.ts'
import { migrate } from '../../src/migrate.ts'
import { freshSchema, PG_URL } from '../support/pg.ts'
import { killWorkflows } from './workflows.ts'
import { HARNESS_SQL } from './world.ts'

const WORKER = resolve(import.meta.dir, 'worker.ts')
const AGENT_MS = 1200
const PARALLEL = 5

type Restart = { version: string; audit: boolean }
type Scenario = {
  name: string
  /** `<step>|<ev>|<delayMs>|<signal>`, scoped to the scenario's target run. */
  kill?: string
  restart?: Restart
  runs?: number
  /** Index of the run the kill targets (concurrency scenario). */
  target?: number
  expectVersion: string
  maxRuns?: number
  journalPool?: number
  /** Orphan sessions expected (killed between session create and handle journal). */
  orphans?: number
}

const v2: Restart = { version: 'v2', audit: false }
const v2break: Restart = { version: 'v2-break', audit: true }

const SCENARIOS: Scenario[] = [
  { name: 'happy', expectVersion: 'v1' },
  { name: 'b-agent-open', kill: 'agent.open|start|0|SIGKILL', expectVersion: 'v1' },
  { name: 'b-effect', kill: 'effect|start|0|SIGKILL', expectVersion: 'v1' },
  { name: 'b-fanout', kill: 'work|start|0|SIGKILL', expectVersion: 'v1' },
  { name: 'b-finish', kill: 'finish|start|0|SIGKILL', expectVersion: 'v1' },
  { name: 'm-prepare', kill: 'prepare|end|0|SIGKILL', expectVersion: 'v1' },
  { name: 'm-agent-open', kill: 'agent.open|end|0|SIGKILL', expectVersion: 'v1', orphans: 1 },
  { name: 'm-agent', kill: `agent|start|${AGENT_MS / 2}|SIGKILL`, expectVersion: 'v1' },
  { name: 'm-effect', kill: 'effect|committed|0|SIGKILL', expectVersion: 'v1' },
  { name: 'm-child', kill: 'work|start|100|SIGKILL', expectVersion: 'v1' },
  { name: 'deploy', kill: `agent|start|${AGENT_MS / 2}|SIGTERM`, restart: v2, expectVersion: 'v2' },
  { name: 'deploy-break', kill: `agent|start|${AGENT_MS / 2}|SIGTERM`, restart: v2break, expectVersion: 'v2-break' },
  { name: 'deploy-break-late', kill: 'work|start|0|SIGTERM', restart: v2break, expectVersion: 'v2-break' },
  {
    name: 'concurrent-25',
    runs: 25,
    target: 12,
    kill: `agent|start|${AGENT_MS / 2}|SIGKILL`,
    expectVersion: 'v1',
    maxRuns: 30,
    journalPool: 3,
  },
]

type Ledger = {
  scenario: string
  runs: number
  done: number
  versions: string[]
  workers: number
  peak: number
  completedReRuns: number
  inDoubtReRuns: number
  effectsInserted: number
  effectDuplicates: number
  promptsSent: number
  promptNoops: number
  sessions: number
  promptedSessions: number
  sessionsPromptedTwice: number
  auditsRun: number
  wallMs: number
}

const pool = new Pool({ connectionString: PG_URL, max: 4 })
const schemas: { drop(): Promise<void> }[] = []
const ledgers: Ledger[] = []

afterAll(async () => {
  await Promise.all(schemas.map((s) => s.drop()))
  await pool.end()
})

async function runScenario(s: Scenario): Promise<Ledger> {
  const started = Date.now()
  const db = freshSchema(`k${s.name.replaceAll('-', '').slice(0, 12)}`)
  schemas.push(db)
  await migrate(pool, db.schema)
  await pool.query(HARNESS_SQL(db.schema))

  const { main } = killWorkflows(null, { version: 'v1', withAudit: false, effectWindowMs: 0, childMs: 0 })
  const starter = new Runtime({ connectionString: PG_URL, schema: db.schema, workflows: [main], journalPoolSize: 1 })
  const runIds: string[] = []
  for (let i = 0; i < (s.runs ?? 1); i++) runIds.push((await starter.start(main, {}, { purpose: 'eval' })).runId)
  await starter.close()
  const target = runIds[s.target ?? 0] ?? ''

  const output: string[] = []
  let workers = 0
  const spawn = (restart: Restart | null, killAt: string | null) => {
    workers++
    const proc = Bun.spawn(['bun', WORKER], {
      env: {
        ...process.env,
        KILL_SCHEMA: db.schema,
        WF_VERSION: restart?.version ?? 'v1',
        WF_AUDIT: restart?.audit ? '1' : '0',
        KILL_AT: killAt ? `${target}|${killAt}` : '',
        AGENT_MS: String(AGENT_MS),
        MAX_RUNS: String(s.maxRuns ?? 4),
        JOURNAL_POOL: String(s.journalPool ?? 2),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void collect(proc.stdout, output)
    void collect(proc.stderr, output)
    return proc
  }

  let proc = spawn(null, s.kill ?? null)
  const deadline = Date.now() + 40_000
  try {
    for (;;) {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from "${db.schema}".runs where parent_id is null and status in ('done','failed','cancelled')`,
      )
      if ((rows[0]?.n ?? 0) === runIds.length) break
      if (Date.now() > deadline) throw new Error(`${s.name}: runs did not finish\n${output.join('')}`)
      if (proc.exitCode !== null || proc.signalCode !== null) {
        await Bun.sleep(100)
        proc = spawn(s.restart ?? null, null)
      }
      await Bun.sleep(50)
    }
  } finally {
    proc.kill('SIGTERM')
    await proc.exited
  }
  const ledger = await readLedger(db.schema, s, runIds.length, workers, Date.now() - started)
  if (process.env.KILL_HARNESS_VERBOSE) console.log(output.join(''))
  return ledger
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) into.push(decoder.decode(chunk))
}

async function readLedger(schema: string, s: Scenario, runs: number, workers: number, wallMs: number): Promise<Ledger> {
  const q = async (sql: string) => (await pool.query<{ n: number }>(sql)).rows[0]?.n ?? 0
  const t = (name: string) => `"${schema}".${name}`
  const { rows: versions } = await pool.query<{ v: string }>(
    `select distinct version_finished as v from ${t('runs')} where parent_id is null order by 1`,
  )
  // A completed step re-ran when its body started again after its journal commit.
  const reRuns = (committed: boolean) => `
    select count(*)::int as n from ${t('h_probes')} p
    where p.ev = 'start' and p.step in ('prepare', 'audit', 'effect', 'finish', 'work')
      and ${committed ? '' : 'not'} exists (select 1 from ${t('h_commits')} c
        where c.run_id = p.run_id and c.step_id = p.step and c.at < p.at)
      and exists (select 1 from ${t('h_probes')} e where e.run_id = p.run_id and e.step = p.step and e.ev = 'start' and e.id < p.id)`
  return {
    scenario: s.name,
    runs,
    done: await q(`select count(*)::int as n from ${t('runs')} where parent_id is null and status = 'done'`),
    versions: versions.map((r) => r.v),
    workers,
    peak: await q(`select coalesce(max(peak), 0)::int as n from ${t('h_peak')}`),
    completedReRuns: await q(reRuns(true)),
    inDoubtReRuns: await q(reRuns(false)),
    effectsInserted: await q(`select count(*)::int as n from ${t('h_effect_attempts')} where outcome = 'inserted'`),
    effectDuplicates: await q(`select count(*)::int as n from ${t('h_effect_attempts')} where outcome = 'duplicate'`),
    promptsSent: await q(`select count(*)::int as n from ${t('h_prompts')} where outcome = 'sent'`),
    promptNoops: await q(`select count(*)::int as n from ${t('h_prompts')} where outcome = 'noop'`),
    sessions: await q(`select count(*)::int as n from ${t('h_sessions')}`),
    promptedSessions: await q(`select count(*)::int as n from ${t('h_sessions')} where prompted_at is not null`),
    sessionsPromptedTwice: await q(
      `select count(*)::int as n from (select session_id from ${t('h_prompts')} where outcome = 'sent'
       group by session_id having count(*) > 1) x`,
    ),
    auditsRun: await q(`select count(*)::int as n from ${t('h_probes')} where step = 'audit' and ev = 'end'`),
    wallMs,
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const queue = [...items]
  const workers = Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) results.push(await fn(item))
  })
  await Promise.all(workers)
  return results
}

test('kill harness: no completed step re-runs, effects once, sessions prompted once, deploys continue on new code', async () => {
  const single = SCENARIOS.filter((s) => !s.runs)
  const concurrent = SCENARIOS.filter((s) => s.runs)
  ledgers.push(...(await inBatches(single, PARALLEL, runScenario)))
  for (const s of concurrent) ledgers.push(await runScenario(s))
  ledgers.sort(
    (a, b) => SCENARIOS.findIndex((s) => s.name === a.scenario) - SCENARIOS.findIndex((s) => s.name === b.scenario),
  )
  console.log(formatLedger(ledgers))

  for (const l of ledgers) {
    const s = SCENARIOS.find((x) => x.name === l.scenario) as Scenario
    const label = `${l.scenario}: ${JSON.stringify(l)}`
    expect(l.done, label).toBe(l.runs)
    expect(l.versions, label).toEqual([s.expectVersion])
    expect(l.completedReRuns, label).toBe(0)
    expect(l.effectsInserted, label).toBe(l.runs)
    expect(l.promptsSent, label).toBe(l.runs)
    expect(l.promptedSessions, label).toBe(l.runs)
    expect(l.sessionsPromptedTwice, label).toBe(0)
    expect(l.sessions, label).toBe(l.runs + (s.orphans ?? 0))
    if (s.kill) expect(l.workers, label).toBeGreaterThanOrEqual(2)
    if (s.runs) expect(l.peak, label).toBeGreaterThanOrEqual(s.runs)
    expect(l.auditsRun, label).toBe(s.restart?.audit ? 1 : 0)
  }
}, 90_000)

function formatLedger(rows: Ledger[]): string {
  const head =
    '| scenario | runs done | finished on | workers | peak | completed re-runs | in-doubt re-runs | effects inserted / dup | prompts sent / no-op | sessions (prompted) | audit ran | wall |'
  const sep = '|-|-|-|-|-|-|-|-|-|-|-|-|'
  const body = rows.map(
    (l) =>
      `| ${l.scenario} | ${l.done}/${l.runs} | ${l.versions.join(',')} | ${l.workers} | ${l.peak} | ${l.completedReRuns} | ${l.inDoubtReRuns} | ${l.effectsInserted} / ${l.effectDuplicates} | ${l.promptsSent} / ${l.promptNoops} | ${l.sessions} (${l.promptedSessions}) | ${l.auditsRun} | ${(l.wallMs / 1000).toFixed(1)} s |`,
  )
  return ['kill-harness ledger', head, sep, ...body].join('\n')
}
