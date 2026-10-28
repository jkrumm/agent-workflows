import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  costOf,
  extractAll,
  inputOf,
  legacyCheck,
  legacyReview,
  parseUsage,
  repoOf,
  type Sources,
  type Span,
  wallOf,
} from '../src/extract/agent-gateway.ts'

const T = 1_790_000_000_000
const SEC = T / 1000
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function git(cwd: string, args: string[], date?: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  }
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  const run = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

function commit(dir: string, file: string, body: string, when: number, message: string): string {
  writeFileSync(join(dir, file), body)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message], `${when} +0000`)
  return git(dir, ['rev-parse', 'HEAD'])
}

/** A home with one repo (SourceRoot/fixture): master has two commits, a PR ref points at a feature commit. */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'agw-extract-'))
  const repo = join(home, 'SourceRoot', 'fixture')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'master'])
  const first = commit(repo, 'a.ts', 'export const a = 1\n', SEC - 7200, 'first')
  const second = commit(repo, 'a.ts', 'export const a = 2\n', SEC - 1800, 'second')
  // Checkouts are dated like the commits around them, so HEAD's reflog tells the same story as the commit dates.
  git(repo, ['checkout', '-q', '-b', 'feature'], `${SEC - 900} +0000`)
  const feature = commit(repo, 'b.ts', 'export const b = 1\n', SEC - 600, 'feature')
  git(repo, ['checkout', '-q', 'master'], `${SEC - 500} +0000`)
  git(repo, ['update-ref', 'refs/pull/7/head', feature])
  return { home, repo, first, second, feature }
}

interface JobSeed {
  id: string
  tool: string
  params: Record<string, unknown>
  status?: string
  result?: unknown
  createdMs?: number
  startedMs?: number | null
  finishedMs?: number | null
}

function writeJobsDb(
  path: string,
  jobs: JobSeed[],
  stats: { id: string; tool: string; startedMs: number; finishedMs: number }[] = [],
) {
  const db = new Database(path)
  db.run(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, tool TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)',
  )
  db.run(
    'CREATE TABLE job_stats (id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)',
  )
  for (const job of jobs) {
    db.query('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      job.id,
      job.tool,
      JSON.stringify(job.params),
      job.status ?? 'done',
      job.result === undefined ? null : JSON.stringify(job.result),
      job.createdMs ?? T,
      job.startedMs === undefined ? T : job.startedMs,
      job.finishedMs === undefined ? T + 60_000 : job.finishedMs,
    )
  }
  for (const s of stats)
    db.query('INSERT INTO job_stats VALUES (?, ?, ?, ?, ?, ?)').run(s.id, s.tool, 'done', T, s.startedMs, s.finishedMs)
  db.close()
}

const CLEAN = {
  outcome: 'clean',
  blocking: [],
  improvements: [],
  discussions: [],
  testGaps: [],
  schemaVersion: 2,
  summary: '',
}
const NEEDS_HUMAN = {
  outcome: 'needs-human',
  blocking: [{ file: 'a.ts', line: 3, message: 'blocks', angle: 'architect' }],
  improvements: [{ file: 'b.ts', message: 'nicer', angle: 'senior-dev' }],
  discussions: [{ file: 'c.ts', line: 9, message: 'debatable', angle: 'backend' }],
  testGaps: ['no test for b'],
  schemaVersion: 2,
  summary: '',
}

function fixtureSources() {
  const fixture = fixtureHome()
  const { home } = fixture
  const share = mkdtempSync(join(tmpdir(), 'agw-extract-share-'))
  const jobsDb = join(share, 'jobs.db')
  const corpus = join(share, 'corpus.jsonl')
  const usageDir = join(share, 'usage')
  mkdirSync(usageDir)
  const worktree = join(home, 'SourceRoot', 'fixture', '.claude', 'worktrees', 'w1')
  const other = join(home, 'Elsewhere', 'thing')
  const sources: Sources = { home, jobsDb, corpus, usageDir }
  return { ...fixture, worktree, other, sources }
}

describe('repoOf', () => {
  const home = '/home/u'

  test('relativises SourceRoot and IuRoot repos', () => {
    expect(repoOf('/home/u/SourceRoot/dotfiles', home)).toEqual({
      value: { repo: 'SourceRoot/dotfiles', nested: false },
    })
    expect(repoOf('/home/u/IuRoot/prometheus-epx/', home)).toEqual({
      value: { repo: 'IuRoot/prometheus-epx', nested: false },
    })
  })

  test('maps a worktree path to its repo', () => {
    expect(repoOf('/home/u/SourceRoot/agent-workflows/.claude/worktrees/w4-eval', home)).toEqual({
      value: { repo: 'SourceRoot/agent-workflows', nested: false },
    })
  })

  test('marks a subdirectory of a repo (or of its worktree) as nested, for git to verify', () => {
    expect(repoOf('/home/u/SourceRoot/dotfiles/packages/x', home)).toEqual({
      value: { repo: 'SourceRoot/dotfiles', nested: true },
    })
    expect(repoOf('/home/u/SourceRoot/dotfiles/.claude/worktrees/w1/packages', home)).toEqual({
      value: { repo: 'SourceRoot/dotfiles', nested: true },
    })
  })

  test('skips paths outside home and outside the two roots', () => {
    expect(repoOf('/opt/x', home)).toEqual({ skip: 'repo-outside-home' })
    expect(repoOf('/home/u/Elsewhere/x', home)).toEqual({ skip: 'repo-unmapped' })
  })
})

describe('legacyReview', () => {
  test('maps each severity and keeps angle, file, line, message', () => {
    const mapped = legacyReview(NEEDS_HUMAN, {})
    expect('value' in mapped && mapped.value.findings).toEqual([
      { severity: 'blocking', file: 'a.ts', line: 3, message: 'blocks', angle: 'architect' },
      { severity: 'improvement', file: 'b.ts', message: 'nicer', angle: 'senior-dev' },
      { severity: 'discussion', file: 'c.ts', line: 9, message: 'debatable', angle: 'backend' },
    ])
  })

  test('(review pipeline) discussions name the failed reviewers', () => {
    const result = {
      ...CLEAN,
      discussions: [
        { file: '(review pipeline)', angle: 'security', message: 'security session failed: the shell tool was denied' },
        { file: '(review pipeline)', angle: 'backend', message: 'the backend review did not run' },
        { file: 'x.ts', angle: 'senior-dev', message: 'ordinary note' },
      ],
    }
    const mapped = legacyReview(result, {})
    expect('value' in mapped && mapped.value.failedAngles).toEqual(['security', 'backend'])
    expect('value' in mapped && mapped.value.findings).toHaveLength(3)
  })

  test('depth comes from params, then the result, else null; unknown outcome is unparseable', () => {
    expect(legacyReview(CLEAN, { depth: 'deep' })).toMatchObject({ value: { depth: 'deep' } })
    expect(legacyReview(CLEAN, {})).toMatchObject({ value: { depth: null } })
    expect(legacyReview({ ...CLEAN, outcome: 'maybe' }, {})).toEqual({ skip: 'result-unparseable' })
    expect(legacyReview(null, {})).toEqual({ skip: 'no-result' })
  })

  test('inputOf drops cwd and caller only', () => {
    expect(inputOf({ cwd: '/x', caller: 'y', pr: 3, depth: 'light' })).toEqual({ pr: 3, depth: 'light' })
  })
})

describe('legacyCheck', () => {
  test('keeps step names and errors; an unknown step is skipped', () => {
    expect(legacyCheck({ passed: false, steps: [{ name: 'lint', passed: false, errors: ['e'] }] })).toEqual({
      value: { passed: false, steps: [{ name: 'lint', passed: false, errors: ['e'] }] },
    })
    expect(legacyCheck({ passed: true, steps: [{ name: 'biome', passed: true }] })).toEqual({ skip: 'step-unknown' })
  })
})

describe('cost and wall time', () => {
  const span = (startMs: number, endMs: number): Span => ({ id: 'x', startMs, endMs })
  const usage = parseUsage(
    [
      JSON.stringify({ jobId: 'j1', costUsd: 0.5 }),
      JSON.stringify({ jobId: 'j1', costUsd: 0.25 }),
      JSON.stringify({ jobId: 'j2', costUsd: null }),
      JSON.stringify({ jobId: 'j3', costUsd: 0.1 }),
      '{"jobId": "truncat',
    ].join('\n'),
    [
      JSON.stringify({ ts: new Date(T + 30_000).toISOString(), tool: 'review:router', cost_usd: 0.02 }),
      JSON.stringify({ ts: new Date(T + 20_000).toISOString(), tool: 'review_ocr', cost_usd: 0.03 }),
      JSON.stringify({ ts: new Date(T + 20_000).toISOString(), tool: 'decide', cost_usd: 9 }),
    ].join('\n'),
  )
  const j1 = span(T, T + 60_000)
  const other = span(T + 10_000, T + 90_000)

  test('exact when no IU row falls in the window', () => {
    expect(
      costOf({ id: 'j3', span: span(T + 3_600_000, T + 3_660_000), usage, reviewSpans: [], iuApplies: true }),
    ).toEqual({
      costUsd: 0.1,
      costExact: true,
    })
  })

  test('approximate when an IU row is added (sole review running in its window)', () => {
    expect(costOf({ id: 'j1', span: j1, usage, reviewSpans: [j1], iuApplies: true })).toEqual({
      costUsd: 0.8,
      costExact: false,
    })
  })

  test('approximate when an IU row is excluded (two reviews overlap it)', () => {
    expect(costOf({ id: 'j1', span: j1, usage, reviewSpans: [j1, other], iuApplies: true })).toEqual({
      costUsd: 0.75,
      costExact: false,
    })
  })

  test('null cost without session rows; unknown window is approximate', () => {
    expect(costOf({ id: 'j2', span: j1, usage, reviewSpans: [j1], iuApplies: true })).toEqual({
      costUsd: null,
      costExact: false,
    })
    expect(costOf({ id: 'j1', span: null, usage, reviewSpans: [], iuApplies: true })).toEqual({
      costUsd: 0.75,
      costExact: false,
    })
  })

  test('wall time is the window length, null without one', () => {
    expect(wallOf(j1)).toBe(60_000)
    expect(wallOf(null)).toBeNull()
  })
})

describe('extractAll', () => {
  test('maps, skips with reasons, dedupes against the corpus, and reads the sibling cost rows', () => {
    const { home, repo, first, second, feature, worktree, other, sources } = fixtureSources()
    // A commit after the job time: every ref must still resolve to what it was when the job ran.
    commit(repo, 'a.ts', 'export const a = 3\n', SEC + 3600, 'after the job')
    mkdirSync(join(repo, 'sub'))
    // A folder under a root that is not a checkout: nothing to verify the cwd against.
    mkdirSync(join(home, 'IuRoot', 'plain', 'x'), { recursive: true })

    writeJobsDb(sources.jobsDb, [
      // PR job: worktree cwd maps to the repo; diff rebuilt from refs/pull/7/head; cost gets an IU row.
      {
        id: 'pr-job',
        tool: 'review',
        params: { cwd: worktree, pr: 7, depth: 'deep', caller: 'x' },
        result: NEEDS_HUMAN,
        startedMs: T,
        finishedMs: T + 60_000,
      },
      // Overlaps pr-job at T+20s: two reviews running, so the OCR row is excluded from both.
      {
        id: 'overlap',
        tool: 'review',
        params: { cwd: worktree, scope: 'HEAD~1' },
        status: 'failed',
        result: CLEAN,
        startedMs: T + 10_000,
        finishedMs: T + 90_000,
      },
      {
        id: 'scope-job',
        tool: 'review',
        params: { cwd: join(repo), scope: 'HEAD~1' },
        result: CLEAN,
        startedMs: T + 3_600_000,
        finishedMs: T + 3_660_000,
      },
      {
        id: 'subdir-job',
        tool: 'review',
        params: { cwd: join(repo, 'sub'), scope: 'HEAD~1' },
        result: CLEAN,
        startedMs: T + 7_200_000,
        finishedMs: T + 7_260_000,
      },
      { id: 'uncommitted-job', tool: 'review', params: { cwd: repo }, result: CLEAN },
      { id: 'branch-job', tool: 'review', params: { cwd: repo, branch: 'feature' }, result: CLEAN },
      { id: 'elsewhere-job', tool: 'review', params: { cwd: other, scope: 'HEAD~1' }, result: CLEAN },
      {
        id: 'plain-job',
        tool: 'review',
        params: { cwd: join(home, 'IuRoot', 'plain', 'x'), scope: 'HEAD~1' },
        result: CLEAN,
      },
      { id: 'no-result-job', tool: 'review', params: { cwd: repo, scope: 'HEAD~1' }, result: null },
      { id: 'no-ref-job', tool: 'review', params: { cwd: repo, pr: 99 }, result: CLEAN },
      { id: 'corpus-1', tool: 'review', params: { cwd: repo, scope: 'HEAD~1' }, result: CLEAN },
      {
        id: 'check-job',
        tool: 'check',
        params: { cwd: repo },
        result: { passed: false, steps: [{ name: 'lint', passed: false, errors: ['x'] }] },
        createdMs: T,
      },
      { id: 'check-elsewhere', tool: 'check', params: { cwd: other }, result: { passed: true, steps: [] } },
      {
        id: 'check-unknown-step',
        tool: 'check',
        params: { cwd: repo },
        result: { passed: true, steps: [{ name: 'biome', passed: true }] },
      },
    ])

    writeFileSync(
      sources.corpus,
      [
        JSON.stringify({
          jobId: 'corpus-1',
          createdAt: T,
          repo,
          params: { cwd: repo, pr: 3, context: 'corpus', caller: 'x' },
          baseSha: SHA_A,
          headSha: SHA_B,
          diff: 'diff --git a/x b/x\n',
          result: {
            ...NEEDS_HUMAN,
            discussions: [{ file: '(review pipeline)', angle: 'security', message: 'security session failed: denied' }],
          },
        }),
        JSON.stringify({
          jobId: 'corpus-2',
          createdAt: T + 1000,
          repo: join(worktree),
          params: { cwd: worktree, scope: 'x..y' },
          baseSha: SHA_A,
          headSha: feature.slice(0, 7),
          diff: 'diff --git a/y b/y\n',
          result: CLEAN,
        }),
      ].join('\n'),
    )
    writeFileSync(
      join(sources.usageDir, 'agent-gateway-sessions.jsonl'),
      [
        JSON.stringify({ jobId: 'pr-job', costUsd: 0.5 }),
        JSON.stringify({ jobId: 'pr-job', costUsd: 0.25 }),
        JSON.stringify({ jobId: 'scope-job', costUsd: 0.2 }),
        JSON.stringify({ jobId: 'check-job', costUsd: 0.1 }),
        JSON.stringify({ jobId: 'corpus-1', costUsd: 1 }),
      ].join('\n'),
    )
    writeFileSync(
      join(sources.usageDir, 'agent-gateway-iu.jsonl'),
      [
        JSON.stringify({ ts: new Date(T + 20_000).toISOString(), tool: 'review_ocr', cost_usd: 0.03 }),
        JSON.stringify({ ts: new Date(T + 30_000).toISOString(), tool: 'review:router', cost_usd: 0.02 }),
      ].join('\n'),
    )

    const out = extractAll(sources)
    const byId = new Map(out.review.map((c) => [c.id, c]))
    const need = (id: string) => {
      const found = byId.get(id)
      if (!found) throw new Error(`no review case ${id}`)
      return found
    }

    expect([...byId.keys()].sort()).toEqual(['corpus-1', 'corpus-2', 'pr-job', 'scope-job', 'subdir-job'])
    expect(out.tally.review.deduped).toBe(1)
    expect(out.tally.review.skipped).toEqual({
      uncommitted: 1,
      'branch-scope': 1,
      'repo-unmapped': 1,
      'repo-unverified': 1,
      'no-result': 1,
      'pr-ref-missing': 1,
    })
    expect(out.tally.review.written).toBe(5)

    // pr-job: worktree cwd -> repo; diff is merge-base(master, PR head)..PR head, so only b.ts is added.
    const pr = need('pr-job')
    expect(pr.repo).toBe('SourceRoot/fixture')
    expect(pr.baseSha).toBe(second)
    expect(pr.headSha).toBe(feature)
    expect(pr.baseInferred).toBe(true)
    expect(pr.diff).toContain('b.ts')
    expect(pr.input).toEqual({ pr: 7, depth: 'deep' })
    expect(pr.legacy.depth).toBe('deep')
    expect(pr.legacy.findings.map((f) => f.severity)).toEqual(['blocking', 'improvement', 'discussion'])
    expect(pr.legacy.wallMs).toBe(60_000)
    expect(pr.legacy).toMatchObject({ costUsd: 0.75, costExact: false })

    // scope-job: a HEAD~1 scope diffs HEAD~1..HEAD; no IU row in its window -> exact.
    const scope = need('scope-job')
    expect(scope.baseSha).toBe(first)
    expect(scope.headSha).toBe(second)
    expect(scope.diff).not.toContain('a = 3')
    expect(scope.legacy).toMatchObject({ costUsd: 0.2, costExact: true, wallMs: 60_000 })

    // corpus wins the duplicate; a worktree path maps to the repo; pipeline discussion -> failedAngles.
    expect(need('corpus-1').source).toBe('corpus-2026-10-19')
    expect(need('corpus-1').baseInferred).toBe(false)
    expect(need('corpus-1').legacy.failedAngles).toEqual(['security'])
    expect(need('corpus-1').legacy).toMatchObject({ costUsd: 1, costExact: false, wallMs: 60_000 })
    expect(need('corpus-2').repo).toBe('SourceRoot/fixture')
    expect(need('corpus-2').headSha).toBe(feature)
    expect(need('corpus-2').input).toEqual({ scope: 'x..y' })
    // A cwd inside the repo maps to the enclosing repo, verified with git.
    expect(need('subdir-job').repo).toBe('SourceRoot/fixture')

    expect(out.tally.check.written).toBe(1)
    expect(out.tally.check.skipped).toEqual({ 'repo-unmapped': 1, 'step-unknown': 1 })
    const check = out.check[0]
    if (!check) throw new Error('no check case')
    expect(check.baseSha).toBe(second)
    expect(check.baseInferred).toBe(true)
    expect(check.patch).toBeUndefined()
    expect(check.legacy).toMatchObject({ passed: false, costUsd: 0.1, costExact: true })
    expect(out.repos.size).toBe(1)
  })
})
