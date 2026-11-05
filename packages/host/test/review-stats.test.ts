import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { freshSchema, PG_URL, testRuntime } from '@agent-workflows/testing/pg'
import { createReviewService, ReviewError } from '../src/review/index.ts'
import { gitRunner } from '../src/review/route.ts'
import { fakeReviewer, lines, makeRepo, write } from './support/review-repo.ts'

const db = freshSchema('rv4stats')
const pool = new Pool({ connectionString: PG_URL, max: 4 })
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-rv4-stats-')))
const repos: string[] = []
const service = createReviewService({ pool, schema: db.schema, stateDir, git: gitRunner, env: { ...process.env } })

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await pool.end()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
  for (const r of repos) rmSync(r, { recursive: true, force: true })
})

const T0 = Date.parse('2026-01-01T00:00:00Z')
const at = (offsetS: number) => new Date(T0 + offsetS * 1000)

interface JobRow {
  id: string
  repo: string
  tier: string
  rule: string
  round: number
  state: 'prepared' | 'submitted' | 'abandoned'
  prompt?: string | null
  outcome?: string
  wallS?: number
  createdAt?: Date
}
async function insertJob(j: JobRow) {
  const created = j.createdAt ?? at(0)
  await pool.query(
    `insert into "${db.schema}".review_jobs (id, repo, root, thread, round, scope, base, diff_base, head, head_tree, tier,
       rule, decided_by, route, review_config, files, job_dir, worktree, state, output, created_at, submitted_at,
       reviewer_prompt)
     values ($1, $2, '/r', $1, $3, '{}', 'b', 'b', 'h', 't', $4, $5, 'rule', '{}', '{}', '[]', '/j', '/w', $6, $7, $8, $9,
       $10)`,
    [
      j.id,
      j.repo,
      j.round,
      j.tier,
      j.rule,
      j.state,
      j.outcome ? JSON.stringify({ outcome: j.outcome }) : null,
      created,
      j.state === 'submitted' ? new Date(created.getTime() + (j.wallS ?? 0) * 1000) : null,
      j.prompt ?? null,
    ],
  )
}
async function insertFinding(f: {
  id: string
  jobId: string
  tag: string
  disposition?: string
  lineValid?: boolean | null
  anchored?: boolean | null
}) {
  await pool.query(
    `insert into "${db.schema}".review_findings (id, repo, thread, job_id, last_job_id, round, tag, class, file, message,
       disposition, line_valid, anchored)
     select $1, repo, thread, id, id, round, $3, 'bug', 'f.ts', 'm', $4, $5, $6 from "${db.schema}".review_jobs where id = $2`,
    [f.id, f.jobId, f.tag, f.disposition ?? 'open', f.lineValid ?? null, f.anchored ?? null],
  )
}

const D1 = 'stats.example/d1'
const D2 = 'stats.example/d2'
const A = 'aaaaaaaaaaaa'

beforeAll(async () => {
  await Promise.all([
    insertJob({
      id: 'j1',
      repo: D1,
      tier: 'deep',
      rule: 'sensitive path: a (+1)',
      round: 1,
      state: 'submitted',
      prompt: A,
      outcome: 'clean',
      wallS: 10,
    }),
    insertJob({
      id: 'j2',
      repo: D1,
      tier: 'standard',
      rule: 'sensitive path: a (fix round, thread already deep)',
      round: 2,
      state: 'submitted',
      prompt: A,
      outcome: 'actionable',
      wallS: 30,
    }),
    insertJob({
      id: 'j3',
      repo: D1,
      tier: 'deep',
      rule: '900 changed non-test code lines > 800',
      round: 2,
      state: 'submitted',
      outcome: 'actionable',
      wallS: 20,
    }),
    insertJob({ id: 'j4', repo: D1, tier: 'light', rule: 'tests only', round: 1, state: 'abandoned' }),
    insertJob({ id: 'j5', repo: D1, tier: 'standard', rule: 'default', round: 1, state: 'prepared' }),
    insertJob({
      id: 'j6',
      repo: D1,
      tier: 'light',
      rule: 'small: 3 code lines in 1 files',
      round: 1,
      state: 'submitted',
      prompt: A,
      outcome: 'clean',
      wallS: 4,
    }),
    insertJob({
      id: 'j7',
      repo: D2,
      tier: 'standard',
      rule: 'default',
      round: 1,
      state: 'submitted',
      outcome: 'clean',
      wallS: 6,
      createdAt: at(31 * 86_400),
    }),
    insertJob({
      id: 'j8',
      repo: 'stats.example/.agw-verify/x',
      tier: 'deep',
      rule: 'default',
      round: 1,
      state: 'submitted',
      outcome: 'clean',
      wallS: 1,
    }),
    insertJob({
      id: 'j9',
      repo: 'stats.example/.agw-eval-recall/y',
      tier: 'deep',
      rule: 'default',
      round: 1,
      state: 'submitted',
      outcome: 'clean',
      wallS: 1,
    }),
  ])
  await insertFinding({
    id: 'f1',
    jobId: 'j1',
    tag: 'important',
    disposition: 'fixed',
    lineValid: true,
    anchored: true,
  })
  await insertFinding({
    id: 'f2',
    jobId: 'j1',
    tag: 'important',
    disposition: 'wrong',
    lineValid: true,
    anchored: false,
  })
  await insertFinding({ id: 'f3', jobId: 'j2', tag: 'important' })
  await insertFinding({
    id: 'f4',
    jobId: 'j3',
    tag: 'nit',
    disposition: 'irrelevant',
    lineValid: false,
    anchored: false,
  })
  await insertFinding({ id: 'f5', jobId: 'j3', tag: 'nit', disposition: 'fixed', lineValid: true, anchored: true })
  await insertFinding({ id: 'f6', jobId: 'j3', tag: 'pre-existing' })
  await insertFinding({ id: 'f7', jobId: 'j6', tag: 'important', disposition: 'fixed', lineValid: true })
  await insertFinding({ id: 'f8', jobId: 'j8', tag: 'important', disposition: 'fixed' })
})

const none = { open: 0, fixed: 0, wrong: 0, intentional: 0, irrelevant: 0 }

describe('review stats from direct ledger rows', () => {
  test('by tier: ordered none < light < standard < deep, exact metrics, probe repos left out', async () => {
    const out = await service.stats({ by: 'tier' })
    expect(out.since).toBeNull()
    expect(out.groups.map((g) => [g.key, g.jobs, g.abandoned, g.prepared])).toEqual([
      ['light', 1, 1, 0],
      ['standard', 2, 0, 1],
      ['deep', 2, 0, 0],
    ])
    const deep = out.groups[2]!
    expect(deep).toEqual({
      key: 'deep',
      jobs: 2,
      abandoned: 0,
      prepared: 0,
      wallS: { p50: 10, max: 20 },
      round1: { jobs: 1, clean: 1, cleanRate: 1 },
      findings: { important: 2, nit: 2, preExisting: 1 },
      dispositions: {
        important: { ...none, fixed: 1, wrong: 1 },
        nit: { ...none, fixed: 1, irrelevant: 1 },
      },
      precision: { important: 0.5, nit: 0.5 },
      anchoredShare: 0.5,
      lineValidShare: 0.75,
      deepRound2: { count: 1, share: 0.5 },
    })
    expect(out.groups[0]).toMatchObject({
      round1: { jobs: 1, clean: 1, cleanRate: 1 },
      precision: { important: 1, nit: null },
      anchoredShare: null,
      lineValidShare: 1,
      deepRound2: { count: 0, share: 0 },
    })
    expect(out.total).toMatchObject({
      jobs: 5,
      abandoned: 1,
      prepared: 1,
      wallS: { p50: 10, max: 30 },
      round1: { jobs: 3, clean: 3, cleanRate: 1 },
      findings: { important: 4, nit: 2, preExisting: 1 },
      precision: { important: 2 / 3, nit: 0.5 },
    })
  })

  test('by rule, prompt and repo', async () => {
    const rule = await service.stats({ by: 'rule' })
    expect(rule.groups.map((g) => [g.key, g.jobs])).toEqual([
      ['default', 1],
      ['sensitive path', 1],
      ['sensitive path (fix round)', 1],
      ['size', 1],
      ['small', 1],
      ['tests only', 0],
    ])
    const prompt = await service.stats({ by: 'prompt' })
    expect(prompt.groups.map((g) => [g.key, g.jobs])).toEqual([
      [A, 3],
      ['unknown', 2],
    ])
    const byRepo = await service.stats({ by: 'repo' })
    expect(byRepo.groups.map((g) => [g.key, g.jobs])).toEqual([
      [D1, 4],
      [D2, 1],
    ])
  })

  test('since and repo filter; a malformed since is refused', async () => {
    const since = await service.stats({ by: 'repo', since: '2026-01-15T00:00:00Z' })
    expect(since.since).toBe('2026-01-15T00:00:00.000Z')
    expect(since.groups.map((g) => [g.key, g.jobs])).toEqual([[D2, 1]])
    const repo = await service.stats({ by: 'tier', repo: D2 })
    expect(repo.groups.map((g) => [g.key, g.jobs])).toEqual([['standard', 1]])
    expect(repo.total.wallS).toEqual({ p50: 6, max: 6 })
    expect((await service.stats({ by: 'tier', repo: 'stats.example/none' })).groups).toEqual([])
    const error = await service.stats({ since: 'yesterday-ish' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ReviewError)
  })

  test('the default grouping is tier', async () => {
    expect((await service.stats({})).by).toBe('tier')
  })
})

describe('review stats through the real flow', () => {
  test('prepare, submit and dispose land in the numbers', async () => {
    const root = makeRepo({ 'src/a.ts': lines(60) })
    repos.push(root)
    write(root, 'src/a.ts', lines(62))
    const prepared = await service.prepare({ cwd: root })
    const { jobId, jobDir, thread } = prepared
    if (!jobId || !jobDir) throw new Error('not ready')
    await service.submit({
      jobId,
      attempt: 1,
      reply: fakeReviewer(jobDir, [
        { tag: 'important', file: 'src/a.ts', line: 61, message: 'one' },
        { tag: 'important', file: 'src/a.ts', line: 1, message: 'two' },
        { tag: 'nit', file: 'src/a.ts', line: 61, message: 'three' },
      ]),
    })
    await service.dispose({ jobId, findingId: `${thread}-1`, disposition: 'fixed' })
    await service.dispose({ jobId, findingId: `${thread}-2`, disposition: 'irrelevant', reason: 'dead code' })

    const out = await service.stats({ by: 'tier', repo: realpathSync(root) })
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]).toMatchObject({
      key: 'light',
      jobs: 1,
      round1: { jobs: 1, clean: 0, cleanRate: 0 },
      findings: { important: 2, nit: 1, preExisting: 0 },
      dispositions: { important: { ...none, fixed: 1, irrelevant: 1 }, nit: { ...none, open: 1 } },
      precision: { important: 0.5, nit: null },
      anchoredShare: 2 / 3,
      lineValidShare: 1,
      deepRound2: { count: 0, share: 0 },
    })
    expect(out.groups[0]?.wallS.p50).toBeGreaterThanOrEqual(0)
  })
})
