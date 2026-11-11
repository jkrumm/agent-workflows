import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { freshSchema, PG_URL, testRuntime } from '@agent-workflows/testing/pg'
import { createHash } from 'node:crypto'
import { createReviewService, type QuotaReading, ReviewError } from '../src/review/index.ts'
import { reviewLedger } from '../src/review/ledger.ts'
import { normalizeOrigin } from '../src/review/repo.ts'
import { gitRunner } from '../src/review/route.ts'
import type { PrepareOutputValue, ReviewOutputV4Value } from '../src/review/schema.ts'
import { commit, fakeReviewer, git, lines, makeRepo, write } from './support/review-repo.ts'

const db = freshSchema('rv4')
const pool = new Pool({ connectionString: PG_URL, max: 4 })
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-rv4-state-')))
const repos: string[] = []

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open() // migrates the schema, 0017_review_ledger included
  await rt.close()
})
afterAll(async () => {
  await pool.end()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
  for (const r of repos) rmSync(r, { recursive: true, force: true })
})

const service = (
  options: { quota?: (account: string) => Promise<QuotaReading | null>; env?: Record<string, string> } = {},
) =>
  createReviewService({
    pool,
    schema: db.schema,
    stateDir,
    git: gitRunner,
    env: { ...process.env, ...options.env },
    ...(options.quota ? { quota: options.quota } : {}),
  })

const repo = (files: Record<string, string>) => {
  const root = makeRepo(files)
  repos.push(root)
  return root
}

const REVIEW_MD = `---
none: [docs/**]
sensitive: [core/**]
nits: 1
---
# REVIEW.md
`

const rejects = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ReviewError)
  expect((error as Error).message).toMatch(pattern)
}

const ready = async (out: Promise<PrepareOutputValue>) => {
  const prepared = await out
  const { jobId, jobDir, worktree, tier } = prepared
  if (prepared.status !== 'ready' || !jobId || !jobDir || !worktree || !tier) {
    throw new Error(`not ready: ${JSON.stringify(prepared)}`)
  }
  return { ...prepared, jobId, jobDir, worktree, tier }
}

const jobRow = async (id: string) =>
  (await pool.query(`select * from "${db.schema}".review_jobs where id = $1`, [id])).rows[0]
const jobRowOfAccount = async (account: string) =>
  (
    await pool.query(`select * from "${db.schema}".review_jobs where account = $1 order by created_at desc limit 1`, [
      account,
    ])
  ).rows[0]
const findingRows = async (thread: string) =>
  (await pool.query(`select * from "${db.schema}".review_findings where thread = $1 order by id`, [thread])).rows

describe('repo identity', () => {
  test('origin URLs normalize to host/owner/name without scheme, credentials or .git', () => {
    expect(normalizeOrigin('https://user:pw@GitHub.com/o/n.git')).toBe('github.com/o/n')
    expect(normalizeOrigin('git@github.com:o/n.git')).toBe('github.com/o/n')
    expect(normalizeOrigin('ssh://git@example.com:22/o/n/')).toBe('example.com/o/n')
    expect(normalizeOrigin('/some/local/path')).toBeNull()
  })
})

describe('prepare', () => {
  test('uncommitted: a snapshot with the untracked file; the caller tree, index, HEAD and refs untouched', async () => {
    const root = repo({ 'src/a.ts': lines(3), 'src/c.ts': lines(2) })
    write(root, 'src/a.ts', lines(5)) // unstaged
    write(root, 'src/c.ts', lines(4))
    git(root, 'add', 'src/c.ts') // staged
    write(root, 'src/u.ts', 'export const untracked = 1\n') // untracked
    const before = {
      status: git(root, 'status', '--porcelain'),
      cached: git(root, 'diff', '--cached'),
      head: git(root, 'rev-parse', 'HEAD'),
      refs: git(root, 'for-each-ref'),
    }

    const out = await ready(service().prepare({ cwd: join(root, 'src'), context: 'add the untracked helper' }))

    expect({
      status: git(root, 'status', '--porcelain'),
      cached: git(root, 'diff', '--cached'),
      head: git(root, 'rev-parse', 'HEAD'),
      refs: git(root, 'for-each-ref'),
    }).toEqual(before)
    expect(out).toMatchObject({
      round: 1,
      base: before.head,
      diffBase: before.head,
      ceiling: 'unjudged',
      account: null,
    })
    expect(out.head).not.toBe(before.head)
    expect(git(root, 'rev-parse', `${out.head}^`)).toBe(before.head) // the snapshot sits on HEAD, unreferenced
    expect(out.files?.sort()).toEqual(['src/a.ts', 'src/c.ts', 'src/u.ts'])
    expect(out.prompt).toBe(`job=${out.jobDir} worktree=${out.worktree} tier=${out.tier} round=1`)
    for (const f of ['job.json', 'diff.patch', 'stat.txt', 'intent.md', 'history.txt', 'prior.json', 'REVIEW.md']) {
      expect(existsSync(join(out.jobDir, f))).toBe(true)
    }
    expect(readFileSync(join(out.worktree, 'src/u.ts'), 'utf8')).toBe('export const untracked = 1\n')
    expect(git(out.worktree, 'rev-parse', 'HEAD')).toBe(out.head)
    expect(readFileSync(join(out.jobDir, 'intent.md'), 'utf8')).toStartWith('add the untracked helper\n')
    expect(readFileSync(join(out.jobDir, 'REVIEW.md'), 'utf8')).toContain('no REVIEW.md')
    const job = JSON.parse(readFileSync(join(out.jobDir, 'job.json'), 'utf8'))
    expect(job.files.agentsMd).toBe(join(out.worktree, 'AGENTS.md'))
    expect(job).toMatchObject({ thread: out.thread, round: 1, head: out.head })
    expect((await jobRow(out.jobId)).state).toBe('prepared')
  })

  test('tier none is skipped with the decision and no job', async () => {
    const root = repo({ 'REVIEW.md': REVIEW_MD, 'src/a.ts': lines(2) })
    commit(root, { 'docs/x.md': '# notes\n' })
    const out = await service().prepare({ cwd: root, scope: 'head' })
    expect(out).toMatchObject({ status: 'skipped', tier: 'none', rule: 'every file matches REVIEW.md none' })
    expect(out.jobId).toBeUndefined()
  })

  test('the quota reading is recorded on the job and never holds it', async () => {
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'src/a.ts', lines(4))
    const readings: Record<string, QuotaReading> = {
      hot: { fiveHour: 95, sevenDay: 99 },
      ultra: { fiveHour: null, sevenDay: 95 },
      empty: { fiveHour: null, sevenDay: null },
    }
    const s = service({ quota: async (a) => readings[a] ?? null })
    const recorded = async (account?: string) => {
      const out = await ready(s.prepare({ cwd: root, ...(account ? { account } : {}) }))
      const { job } = await s.status({ jobId: out.jobId })
      expect(out.status).toBe('ready')
      return [out.ceiling, job?.ceiling, job?.quotaFiveHour, job?.quotaSevenDay]
    }
    expect(await recorded('hot')).toEqual(['ok', 'ok', 95, 99])
    expect(await recorded('ultra')).toEqual(['ok', 'ok', null, 95])
    expect(await recorded('empty')).toEqual(['unknown', 'unknown', null, null])
    expect(await recorded('nobody')).toEqual(['unknown', 'unknown', null, null])
    expect(await recorded()).toEqual(['unjudged', 'unjudged', null, null])
    expect(await jobRowOfAccount('hot')).toMatchObject({ ceiling: 'ok', quota_five_hour: 95, quota_seven_day: 99 })
  })

  test('the deep cap holds a deep review past N per account and day; never a downgrade', async () => {
    const s = service({ env: { AGW_REVIEW_DEEP_CAP: '1' } })
    const one = repo({ 'REVIEW.md': REVIEW_MD, 'core/x.ts': lines(2) })
    write(one, 'core/x.ts', lines(3))
    const first = await ready(s.prepare({ cwd: one, account: 'capped' }))
    expect(first).toMatchObject({ tier: 'deep' })
    // a re-prepare of the same thread restarts the round; it does not count against itself
    expect(await s.prepare({ cwd: one, account: 'capped' })).toMatchObject({ status: 'ready', tier: 'deep' })
    const two = repo({ 'REVIEW.md': REVIEW_MD, 'core/y.ts': lines(2) })
    write(two, 'core/y.ts', lines(3))
    expect(await s.prepare({ cwd: two, account: 'capped' })).toMatchObject({
      status: 'held',
      tier: 'deep',
      reason: 'held: capped at the deep cap, 1/1 deep reviews today (UTC)',
    })
    expect(await s.prepare({ cwd: two, account: 'other' })).toMatchObject({ status: 'ready', tier: 'deep' })
  })

  test('--min raises the routed tier', async () => {
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'src/a.ts', lines(3))
    expect(await service().prepare({ cwd: root, min: 'standard' })).toMatchObject({
      status: 'ready',
      tier: 'standard',
      decidedBy: 'caller',
    })
  })

  test('a re-prepare abandons the unsubmitted job of the same round', async () => {
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'src/a.ts', lines(3))
    const first = await ready(service().prepare({ cwd: root }))
    const second = await ready(service().prepare({ cwd: root }))
    expect(second.thread).toBe(first.thread)
    expect(second.round).toBe(1)
    expect((await jobRow(first.jobId)).state).toBe('abandoned')
    await rejects(service().submit({ jobId: first.jobId, attempt: 1, reply: fakeReviewer(first.jobDir) }), /abandoned/)
  })

  test('scopes: a bad ref and pr with scope are refused', async () => {
    const root = repo({ 'src/a.ts': lines(2) })
    await rejects(service().prepare({ cwd: root, scope: 'nope' }), /not a commit/)
    await rejects(service().prepare({ cwd: root, scope: 'head', pr: 3 }), /omitted/)
    await rejects(service().prepare({ cwd: '/definitely/not/here' }), /does not exist/)
  })
})

describe('submit', () => {
  const s = service()
  let root: string
  beforeAll(() => {
    root = repo({ 'REVIEW.md': REVIEW_MD, 'src/a.ts': lines(2), 'src/b.ts': lines(2) })
  })
  let n = 0
  const prepareChange = async () => {
    write(root, 'src/a.ts', lines(3 + ++n))
    write(root, 'src/b.ts', lines(4))
    return ready(s.prepare({ cwd: root, thread: `submit-${crypto.randomUUID()}` }))
  }

  test('a files list that differs from stat.txt is refused and nothing is written', async () => {
    const job = await prepareChange()
    const reply = fakeReviewer(job.jobDir, [{ tag: 'important', file: 'src/a.ts', message: 'x' }], {
      files: ['src/a.ts', 'src/zzz.ts'],
    })
    await rejects(s.submit({ jobId: job.jobId, attempt: 1, reply }), /missing: src\/b\.ts; extra: src\/zzz\.ts/)
    expect((await jobRow(job.jobId)).state).toBe('prepared')
    expect(await findingRows(job.thread)).toEqual([])
    expect(existsSync(job.worktree)).toBe(true)
  })

  test('a binary file of the range may be listed in the reply or left out; a text file may not', async () => {
    const job = async () => {
      write(root, 'src/a.ts', lines(3 + ++n))
      writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
      return ready(s.prepare({ cwd: root, thread: `binary-${crypto.randomUUID()}` }))
    }
    const first = await job()
    expect(first.files).toContain('logo.png')
    const listed = fakeReviewer(first.jobDir)
    expect(JSON.parse(listed.slice(listed.indexOf('{'), listed.lastIndexOf('}') + 1)).files).toContain('logo.png')
    await s.submit({ jobId: first.jobId, attempt: 1, reply: listed })

    const second = await job()
    const left = fakeReviewer(second.jobDir, [], { files: (second.files ?? []).filter((f) => f !== 'logo.png') })
    expect(await s.submit({ jobId: second.jobId, attempt: 1, reply: left })).toMatchObject({ outcome: 'clean' })

    const third = await job()
    const text = fakeReviewer(third.jobDir, [], { files: ['logo.png'] })
    await rejects(s.submit({ jobId: third.jobId, attempt: 1, reply: text }), /missing: src\/a\.ts/)
  })

  test('code computes summary, outcome and tier; nits capped by REVIEW.md; same attempt idempotent, another refused', async () => {
    const job = await prepareChange()
    const reply = fakeReviewer(job.jobDir, [
      { tag: 'important', file: 'src/a.ts', message: 'off by one' },
      { tag: 'nit', file: 'src/a.ts', message: 'nit one' },
      { tag: 'nit', file: 'src/b.ts', message: 'nit two' },
      { tag: 'nit', file: 'src/b.ts', message: 'nit three' },
    ])
    const out = await s.submit({ jobId: job.jobId, attempt: 1, reply })
    expect(out).toMatchObject({
      schemaVersion: 4,
      jobId: job.jobId,
      tier: job.tier, // the reply said deep
      outcome: 'actionable',
      summary: '1 important, 1 nit.',
      dropped: { repeats: 0, nits: 2 },
      intent: 'does what was asked',
      stepBack: null,
    })
    expect(out.findings.map((f) => f.id)).toEqual([`${job.thread}-1`, `${job.thread}-2`])
    expect(existsSync(job.worktree)).toBe(false) // the tree goes on submit
    expect(await s.submit({ jobId: job.jobId, attempt: 1, reply: 'anything' })).toEqual(out)
    await rejects(s.submit({ jobId: job.jobId, attempt: 2, reply }), /already submitted by attempt 1/)
    const row = await jobRow(job.jobId)
    expect(row).toMatchObject({ state: 'submitted', attempt: 1 })
    expect((await findingRows(job.thread)).length).toBe(2)
  })

  test('a clean reply is clean; a malformed one is refused; an unknown job is refused', async () => {
    const job = await prepareChange()
    await rejects(s.submit({ jobId: job.jobId, attempt: 1, reply: 'no json here' }), /no JSON object/)
    await rejects(s.submit({ jobId: job.jobId, attempt: 1, reply: '{"files": "nope"}' }), /reviewer schema/)
    const out = await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
    expect(out).toMatchObject({ outcome: 'clean', summary: 'Nothing needs fixing.', findings: [] })
    await rejects(s.submit({ jobId: 'rv_unknown', attempt: 1, reply: '{}' }), /unknown job/)
  })
})

describe('convergence over rounds', () => {
  test('round 2 diffs since round 1, carries dispositions, drops repeats, keeps stillOpen ids; round 4 needs a human', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'src/a.ts', `${lines(2)}export const roundOne = 1\n`)
    const r1 = await ready(s.prepare({ cwd: root }))
    const t = r1.thread
    const out1 = await s.submit({
      jobId: r1.jobId,
      attempt: 1,
      reply: fakeReviewer(r1.jobDir, [
        { tag: 'important', file: 'src/a.ts', message: 'Round one leaks a handle.' },
        { tag: 'important', file: 'src/a.ts', message: 'Round one drops an error' },
      ]),
    })
    expect(out1.findings.map((f) => f.id)).toEqual([`${t}-1`, `${t}-2`])
    expect(
      await s.dispose({ jobId: r1.jobId, findingId: `${t}-1`, disposition: 'wrong', reason: 'unreachable' }),
    ).toMatchObject({ id: `${t}-1`, disposition: 'wrong', reason: 'unreachable' })
    // idempotent
    expect(
      await s.dispose({ jobId: r1.jobId, findingId: `${t}-1`, disposition: 'wrong', reason: 'unreachable' }),
    ).toMatchObject({ disposition: 'wrong' })

    write(root, 'src/a.ts', `${lines(2)}export const roundOne = 1\nexport const roundTwo = 2\n`)
    const r2 = await ready(s.prepare({ cwd: root }))
    expect(r2).toMatchObject({ thread: t, round: 2, diffBase: r1.head, base: r1.base })
    const patch = readFileSync(join(r2.jobDir, 'diff.patch'), 'utf8')
    expect(patch).toContain('+export const roundTwo = 2')
    expect(patch).not.toContain('+export const roundOne = 1')
    const prior = JSON.parse(readFileSync(join(r2.jobDir, 'prior.json'), 'utf8'))
    expect(
      prior.map((p: { id: string; state: string; sameThread: boolean }) => [p.id, p.state, p.sameThread]).sort(),
    ).toEqual([
      [`${t}-1`, 'wrong', true],
      [`${t}-2`, 'open', true],
    ])
    const out2 = await s.submit({
      jobId: r2.jobId,
      attempt: 1,
      reply: fakeReviewer(r2.jobDir, [
        { tag: 'important', file: 'src/a.ts', message: 'round ONE leaks a handle' }, // a repeat
        { tag: 'important', file: 'src/a.ts', message: 'still drops it', id: `${t}-2`, stillOpen: true },
        { tag: 'important', file: 'src/a.ts', message: 'Round two overflows' },
      ]),
    })
    expect(out2.findings.map((f) => [f.id, f.stillOpen ?? false])).toEqual([
      [`${t}-2`, true],
      [`${t}-3`, false],
    ])
    expect(out2).toMatchObject({ round: 2, outcome: 'actionable', dropped: { repeats: 1, nits: 0 } })
    const rows = await findingRows(t)
    expect(rows.map((r) => [r.id, r.last_job_id])).toEqual([
      [`${t}-1`, r1.jobId],
      [`${t}-2`, r2.jobId],
      [`${t}-3`, r2.jobId],
    ])

    write(root, 'src/a.ts', `${lines(2)}export const roundOne = 1\nexport const roundTwo = 3\n`)
    const r3 = await ready(s.prepare({ cwd: root }))
    expect(r3).toMatchObject({ round: 3, diffBase: r2.head })
    const out3: ReviewOutputV4Value = await s.submit({
      jobId: r3.jobId,
      attempt: 1,
      reply: fakeReviewer(r3.jobDir, [{ tag: 'important', file: 'src/a.ts', message: 'Round three races' }]),
    })
    expect(out3.outcome).toBe('needs-human')
    expect(out3.stepBack).toMatch(/approach/)

    write(root, 'src/a.ts', `${lines(2)}export const roundFour = 4\n`)
    const r4 = await s.prepare({ cwd: root })
    expect(r4).toMatchObject({ status: 'needs-human', thread: t, round: 4 })
    expect(r4.reason).toMatch(/3 rounds on thread/)
    expect(r4.jobId).toBeUndefined()
    const status = await s.status({ jobId: r3.jobId })
    expect(status.job).toMatchObject({ state: 'submitted', round: 3, outcome: 'needs-human' })
    expect(status.findings?.map((f) => [f.id, f.disposition])).toEqual([
      [`${t}-1`, 'wrong'],
      [`${t}-2`, 'open'],
      [`${t}-3`, 'open'],
      [`${t}-4`, 'open'],
    ])
    const recent = await s.status({ cwd: root })
    expect(recent.jobs?.[0]).toMatchObject({
      id: r3.jobId,
      state: 'submitted',
      round: 3,
      transport: 'in-session',
      openImportant: 3,
    })
    await rejects(s.dispose({ jobId: r1.jobId, findingId: 'other-1', disposition: 'fixed' }), /not in the thread/)
  })
})

describe('convergence by disposition', () => {
  const round1 = async (s: ReturnType<typeof service>, root: string, message: string) => {
    write(root, 'src/a.ts', `${lines(2)}export const roundOne = 1\n`)
    const r1 = await ready(s.prepare({ cwd: root }))
    await s.submit({
      jobId: r1.jobId,
      attempt: 1,
      reply: fakeReviewer(r1.jobDir, [{ tag: 'important', file: 'src/a.ts', message }]),
    })
    return r1
  }
  const round2 = async (
    s: ReturnType<typeof service>,
    root: string,
    finding: { message: string; id?: string; stillOpen?: boolean },
  ) => {
    write(root, 'src/a.ts', `${lines(2)}export const roundOne = 1\nexport const roundTwo = 2\n`)
    const r2 = await ready(s.prepare({ cwd: root }))
    const out = await s.submit({
      jobId: r2.jobId,
      attempt: 1,
      reply: fakeReviewer(r2.jobDir, [{ tag: 'important', file: 'src/a.ts', ...finding }]),
    })
    return { r2, out }
  }

  test('a fixed finding that comes back is reopened under its id and keeps the outcome actionable', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    const r1 = await round1(s, root, 'Leaks a handle.')
    const t = r1.thread
    await s.dispose({ jobId: r1.jobId, findingId: `${t}-1`, disposition: 'fixed' })
    const { r2, out } = await round2(s, root, { message: 'leaks a handle' })
    expect(out.findings.map((f) => [f.id, f.stillOpen ?? false])).toEqual([[`${t}-1`, true]])
    expect(out).toMatchObject({ outcome: 'actionable', dropped: { repeats: 0 } })
    const rows = await findingRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ disposition: 'open', last_job_id: r2.jobId, disposed_at: null })
  })

  test('a settled finding re-reported with stillOpen is dropped as a repeat', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    const r1 = await round1(s, root, 'Leaks a handle.')
    const t = r1.thread
    await s.dispose({ jobId: r1.jobId, findingId: `${t}-1`, disposition: 'wrong', reason: 'unreachable' })
    const { out } = await round2(s, root, { message: 'It still leaks', id: `${t}-1`, stillOpen: true })
    expect(out.findings).toEqual([])
    expect(out).toMatchObject({ outcome: 'clean', dropped: { repeats: 1 } })
    expect((await findingRows(t))[0]).toMatchObject({ disposition: 'wrong' })
  })

  test('an open finding re-reported without stillOpen is kept under its id', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    const r1 = await round1(s, root, 'Leaks a handle.')
    const t = r1.thread
    const { r2, out } = await round2(s, root, { message: 'Leaks a handle' })
    expect(out.findings.map((f) => [f.id, f.stillOpen ?? false])).toEqual([[`${t}-1`, true]])
    expect(out.outcome).toBe('actionable')
    expect((await findingRows(t))[0]).toMatchObject({ disposition: 'open', last_job_id: r2.jobId })
  })

  test('routing reads REVIEW.md at the thread base, not at the previous head', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'REVIEW.md', "---\nnone: ['**']\n---\n")
    const r1 = await ready(s.prepare({ cwd: root }))
    expect(r1.tier).not.toBe('none')
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir, []) })
    write(root, 'src/a.ts', `${lines(2)}export const roundTwo = 2\n`)
    const r2 = await ready(s.prepare({ cwd: root }))
    expect(r2).toMatchObject({ round: 2, diffBase: r1.head })
    expect(r2.tier).not.toBe('none')
  })
})

describe('covered', () => {
  test('snapshot then same-tree commit is covered; later commits are not; none needs nothing; a range job covers its commits; light does not cover deep', async () => {
    const s = service()
    const root = repo({ 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': lines(2) })
    const start = git(root, 'rev-parse', 'HEAD')
    write(root, 'src/a.ts', lines(3))
    const snap = await ready(s.prepare({ cwd: root }))
    await s.submit({ jobId: snap.jobId, attempt: 1, reply: fakeReviewer(snap.jobDir) })
    const c1 = commit(root, {}, 'commit the reviewed tree')
    expect((await s.covered({ cwd: root, range: `${start}..HEAD` })).covered).toBe(true)

    const c2 = commit(root, { 'src/b.ts': lines(2) }, 'unreviewed')
    const c3 = commit(root, { 'docs/x.md': '# plan\n' }, 'docs only')
    const after = await s.covered({ cwd: root, range: `${start}..HEAD` })
    expect(after).toMatchObject({ covered: false, uncovered: [c2] })
    expect(after.commits.map((c) => [c.sha, c.coveredBy])).toEqual([
      [c1, snap.jobId],
      [c2, null],
      [c3, null],
    ])
    expect(after.commits[2]).toMatchObject({ required: 'none', subject: 'docs only' })

    const d1 = commit(root, { 'src/c.ts': lines(2) })
    const d2 = commit(root, { 'src/d.ts': lines(2) })
    const range = await ready(s.prepare({ cwd: root, scope: `${c3}..${d2}`, min: 'deep' }))
    await s.submit({ jobId: range.jobId, attempt: 1, reply: fakeReviewer(range.jobDir) })
    const ranged = await s.covered({ cwd: root, range: `${c3}..${d2}` })
    expect(ranged.covered).toBe(true)
    expect(ranged.commits.map((c) => [c.sha, c.coveredBy])).toEqual([
      [d1, range.jobId],
      [d2, range.jobId],
    ])

    // e1 alone routes deep (> 800 lines), e2 takes them out again: a job on the net change is light
    const e1 = commit(root, { 'src/big.ts': lines(900) })
    git(root, 'rm', '-q', 'src/big.ts')
    const e2 = commit(root, { 'src/e.ts': lines(2) })
    const light = await ready(s.prepare({ cwd: root, scope: `${d2}..${e2}` }))
    expect(light.tier).toBe('light')
    await s.submit({ jobId: light.jobId, attempt: 1, reply: fakeReviewer(light.jobDir) })
    const deep = await s.covered({ cwd: root, range: `${d2}..${e2}` })
    expect(deep.commits.find((c) => c.sha === e1)).toMatchObject({ required: 'deep', coveredBy: null })
    expect(deep.covered).toBe(false)
  })

  describe('open important findings', () => {
    const reviewed = async (findings: { tag: 'important' | 'nit'; file: string; message: string }[]) => {
      const s = service()
      const root = repo({ 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': lines(2) })
      const start = git(root, 'rev-parse', 'HEAD')
      write(root, 'src/a.ts', lines(3))
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir, findings) })
      const c1 = commit(root, {}, 'commit the reviewed tree')
      return { s, root, start, job, c1 }
    }

    test('an open important finding leaves the commit uncovered, naming the finding', async () => {
      const { s, root, start, job, c1 } = await reviewed([{ tag: 'important', file: 'src/a.ts', message: 'Leaks.' }])
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out).toMatchObject({ covered: false, uncovered: [c1] })
      expect(out.commits[0]).toMatchObject({
        coveredBy: null,
        reason: 'open-important',
        findings: [`${job.thread}-1`],
      })
    })

    test('a disposed important finding covers the commit again', async () => {
      const { s, root, start, job } = await reviewed([{ tag: 'important', file: 'src/a.ts', message: 'Leaks.' }])
      await s.dispose({ jobId: job.jobId, findingId: `${job.thread}-1`, disposition: 'wrong', reason: 'unreachable' })
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out.covered).toBe(true)
      expect(out.commits[0]).toMatchObject({ coveredBy: job.jobId })
      expect(out.commits[0]?.reason).toBeUndefined()
    })

    test('an open nit does not block coverage', async () => {
      const { s, root, start, job } = await reviewed([{ tag: 'nit', file: 'src/a.ts', message: 'Rename.' }])
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out.covered).toBe(true)
      expect(out.commits[0]).toMatchObject({ coveredBy: job.jobId })
    })
  })

  describe('a squash-merged, rebased change (patch-id)', () => {
    const body = lines(20)
    const edited = body.replace('line10 = 10', 'line10 = 100')
    // master moves under the reviewed change: a line added on top shifts every line number of a.ts
    const moved = (text: string) => `export const upstream = 1\n${text}`

    const reviewed = async (findings: { tag: 'important' | 'nit'; file: string; message: string }[] = []) => {
      const s = service()
      const root = repo({ 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': body })
      write(root, 'src/a.ts', edited)
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir, findings) })
      git(root, 'checkout', '-q', 'src/a.ts') // the work tree goes back; the change is replayed after master moved
      const upstream = commit(root, { 'src/a.ts': moved(body), 'src/other.ts': lines(2) }, 'unrelated')
      return { s, root, job, upstream }
    }

    test('the replayed change is covered by the job whose patch it equals', async () => {
      const { s, root, job, upstream } = await reviewed()
      const squash = commit(root, { 'src/a.ts': moved(edited) }, 'squash')
      const out = await s.covered({ cwd: root, range: `${upstream}..${squash}` })
      expect(out.covered).toBe(true)
      expect(out.commits[0]).toMatchObject({ sha: squash, coveredBy: job.jobId })
    })

    test('an edit after the last submitted round leaves it uncovered', async () => {
      const { s, root, upstream } = await reviewed()
      const squash = commit(root, { 'src/a.ts': `${moved(edited)}export const afterReview = 1\n` }, 'squash plus fix')
      const out = await s.covered({ cwd: root, range: `${upstream}..${squash}` })
      expect(out).toMatchObject({ covered: false, uncovered: [squash] })
      expect(out.commits[0]?.coveredBy).toBeNull()
    })

    test('a conflict resolution that rewrites a changed line leaves it uncovered', async () => {
      const { s, root, upstream } = await reviewed()
      const resolved = moved(body).replace('line10 = 10', 'line10 = 101')
      const squash = commit(root, { 'src/a.ts': resolved }, 'squash resolved')
      const out = await s.covered({ cwd: root, range: `${upstream}..${squash}` })
      expect(out).toMatchObject({ covered: false, uncovered: [squash] })
    })

    test('an open important finding still wins over the match', async () => {
      const { s, root, job, upstream } = await reviewed([{ tag: 'important', file: 'src/a.ts', message: 'Leaks.' }])
      const squash = commit(root, { 'src/a.ts': moved(edited) }, 'squash')
      const out = await s.covered({ cwd: root, range: `${upstream}..${squash}` })
      expect(out.commits[0]).toMatchObject({
        coveredBy: null,
        reason: 'open-important',
        findings: [`${job.thread}-1`],
      })
    })
  })

  describe('a rebase-merged multi-commit change (per-commit patch-ids)', () => {
    const files = { 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': lines(20), 'src/b.ts': lines(20) }

    // a 3-commit job, reviewed as one range; master moves; then each commit is replayed with a new SHA
    const replayed = async () => {
      const s = service()
      const root = repo(files)
      const start = git(root, 'rev-parse', 'HEAD')
      git(root, 'checkout', '-q', '-b', 'feature')
      const originals = [
        commit(root, { 'src/a.ts': lines(20).replace('line10 = 10', 'line10 = 100') }, 'one'),
        commit(root, { 'src/b.ts': lines(20).replace('line5 = 5', 'line5 = 50') }, 'two'),
        commit(root, { 'src/c.ts': lines(3) }, 'three'),
      ]
      const job = await ready(s.prepare({ cwd: root, scope: `${start}..HEAD`, min: 'deep' }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
      git(root, 'checkout', '-q', '-b', 'landed', start)
      const upstream = commit(root, { 'src/a.ts': `export const upstream = 1\n${lines(20)}` }, 'unrelated')
      for (const sha of originals) git(root, 'cherry-pick', sha)
      const landed = git(root, 'rev-list', '--reverse', `${upstream}..HEAD`).split('\n')
      return { s, root, job, upstream, originals, landed }
    }

    test('every replayed commit is covered by the job whose commit it repeats', async () => {
      const { s, root, job, upstream, originals, landed } = await replayed()
      expect(landed).toHaveLength(3)
      expect(landed.some((sha) => originals.includes(sha))).toBe(false)
      const out = await s.covered({ cwd: root, range: `${upstream}..HEAD` })
      expect(out.commits.map((c) => [c.sha, c.coveredBy])).toEqual(landed.map((sha) => [sha, job.jobId]))
      expect(out.covered).toBe(true)
    })

    test('a commit added after the reviewed ones stays uncovered', async () => {
      const { s, root, job, upstream, landed } = await replayed()
      const extra = commit(root, { 'src/b.ts': `${lines(20)}export const afterReview = 1\n` }, 'after review')
      const out = await s.covered({ cwd: root, range: `${upstream}..HEAD` })
      expect(out.uncovered).toEqual([extra])
      expect(out.commits.slice(0, 3).map((c) => [c.sha, c.coveredBy])).toEqual(landed.map((sha) => [sha, job.jobId]))
    })
  })

  describe('why a commit is uncovered', () => {
    const base = { 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': lines(2), 'src/b.ts': lines(2) }

    test('no review recorded: state no-review, reason no-review', async () => {
      const s = service()
      const root = repo(base)
      const start = git(root, 'rev-parse', 'HEAD')
      const c1 = commit(root, { 'src/b.ts': lines(3) }, 'never reviewed')
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out).toMatchObject({ covered: false, state: 'no-review', uncovered: [c1] })
      expect(out.commits[0]).toMatchObject({ reason: 'no-review' })
      expect(out.commits[0]?.related).toBeUndefined()
    })

    test('a review of the same files that no longer matches: state uncovered, reason stale, naming the job', async () => {
      const s = service()
      const root = repo(base)
      const start = git(root, 'rev-parse', 'HEAD')
      write(root, 'src/a.ts', lines(3))
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
      const c1 = commit(root, { 'src/a.ts': `${lines(3)}export const afterReview = 1\n` }, 'edited after review')
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out).toMatchObject({ covered: false, state: 'uncovered', uncovered: [c1] })
      expect(out.commits[0]).toMatchObject({ reason: 'stale', related: [job.jobId] })
    })

    test('a review below the tier the commit needs: reason tier-too-low', async () => {
      const s = service()
      const root = repo(base)
      const start = git(root, 'rev-parse', 'HEAD')
      write(root, 'src/a.ts', lines(3))
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
      git(root, 'checkout', '-q', 'src/a.ts')
      const c1 = commit(root, { 'src/a.ts': lines(900) }, 'a deep change on the same file')
      const out = await s.covered({ cwd: root, range: `${start}..HEAD` })
      expect(out.commits[0]).toMatchObject({ sha: c1, required: 'deep', reason: 'tier-too-low', related: [job.jobId] })
    })

    test('a covered range says so', async () => {
      const s = service()
      const root = repo(base)
      const start = git(root, 'rev-parse', 'HEAD')
      write(root, 'src/a.ts', lines(3))
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
      commit(root, {}, 'commit the reviewed tree')
      expect((await s.covered({ cwd: root, range: `${start}..HEAD` })).state).toBe('covered')
    })
  })

  test('a 20-commit range with 15 reviews of the same files costs a bounded number of git processes', async () => {
    let spawned = 0
    const counting = createReviewService({
      pool,
      schema: db.schema,
      stateDir,
      git: (cwd, args) => {
        spawned++
        return gitRunner(cwd, args)
      },
      env: process.env,
    })
    const s = service()
    const root = repo({ 'REVIEW.md': '---\nnone: [docs/**]\n---\n', 'src/a.ts': lines(2) })
    const start = git(root, 'rev-parse', 'HEAD')
    for (let i = 0; i < 15; i++) {
      write(root, 'src/a.ts', lines(3 + i))
      const job = await ready(s.prepare({ cwd: root }))
      await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir) })
      commit(root, {}, `reviewed ${i}`)
    }
    for (let i = 0; i < 5; i++) commit(root, { 'src/a.ts': `${lines(18)}export const late${i} = ${i}\n` }, `late ${i}`)
    spawned = 0
    const out = await counting.covered({ cwd: root, range: `${start}..HEAD` })
    expect(out.commits).toHaveLength(20)
    expect(out.commits.slice(0, 15).every((c) => c.coveredBy !== null)).toBe(true)
    expect(out.commits.slice(15).every((c) => c.reason === 'stale')).toBe(true)
    // every job touches the file, the worst case. Before: ~4 processes per (commit, job) pair, 474 here; now the commit
    // facts and the graph once, the router per commit, and git per pair only for the commits no free test covers
    expect(spawned).toBeLessThan(300)
  }, 120_000)

  test('route answers the decision alone', async () => {
    const root = repo({ 'src/a.ts': lines(2) })
    commit(root, { 'src/a.ts': lines(3) })
    expect(await service().route({ cwd: root, base: 'HEAD~1', head: 'HEAD' })).toMatchObject({ tier: 'light' })
    await rejects(service().route({ cwd: root, base: '--output=x', head: 'HEAD' }), /must not start/)
  })
})

describe('cancel, thread keys and the submit account', () => {
  const small = () => {
    const root = repo({ 'src/a.ts': lines(2) })
    commit(root, { 'src/a.ts': lines(3) })
    return root
  }

  const jobState = async (jobId: string) =>
    (await pool.query(`select state from "${db.schema}".review_jobs where id = $1`, [jobId])).rows[0]?.state

  test('cancel refuses a job that is not prepared, naming the state', async () => {
    const s = service()
    const job = await ready(s.prepare({ cwd: small(), scope: 'head', account: 'work' }))
    await s.cancel({ jobId: job.jobId })
    await rejects(s.cancel({ jobId: job.jobId }), /abandoned/)
    await rejects(s.cancel({ jobId: 'nope' }), /unknown job/)
  })

  test('cancel abandons a prepared job and removes its tree', async () => {
    const s = service()
    const job = await ready(s.prepare({ cwd: small(), scope: 'head', account: 'work' }))
    expect(await s.cancel({ jobId: job.jobId })).toEqual({ status: 'cancelled', jobId: job.jobId })
    expect(await jobState(job.jobId)).toBe('abandoned')
    expect(existsSync(job.worktree)).toBe(false)
  })

  test('status prints the thread key; --thread takes the key or the id of an existing thread', async () => {
    const s = service()
    const root = small()
    const first = await ready(s.prepare({ cwd: root, scope: 'head', thread: 'my-key' }))
    expect((await s.status({ jobId: first.jobId })).job?.threadKey).toBe('my-key')
    await s.cancel({ jobId: first.jobId })
    // the id from status continues the thread (here: an abandoned round 1 is still round 1), with the same key
    const byId = await ready(s.prepare({ cwd: root, scope: 'head', thread: first.thread }))
    expect(byId.thread).toBe(first.thread)
    expect((await s.status({ jobId: byId.jobId })).job?.threadKey).toBe('my-key')
    const byKey = await ready(s.prepare({ cwd: root, scope: 'head', thread: 'my-key' }))
    expect(byKey.thread).toBe(first.thread)
    // a 12-hex value the ledger does not hold is a key
    const unknown = await ready(s.prepare({ cwd: root, scope: 'head', thread: 'abcdef012345' }))
    expect(unknown.thread).not.toBe('abcdef012345')
    expect((await s.status({ jobId: unknown.jobId })).job?.threadKey).toBe('abcdef012345')
    // without --thread the resolved key is stored
    const dflt = await ready(s.prepare({ cwd: root, scope: 'head' }))
    expect((await s.status({ jobId: dflt.jobId })).job?.threadKey).toBeTruthy()
    expect((await s.status({ cwd: root })).jobs?.[0]?.threadKey).toBeTruthy()
  })

  test('the default thread key names the branch: two branches cut from one base are two threads', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(2) })
    git(root, 'checkout', '-q', '-b', 'feature-a')
    commit(root, { 'src/a.ts': lines(3) })
    const a1 = await ready(s.prepare({ cwd: root, scope: 'master' }))
    await s.cancel({ jobId: a1.jobId })
    const a2 = await ready(s.prepare({ cwd: root, scope: 'master' }))
    expect(a2.thread).toBe(a1.thread)
    await s.cancel({ jobId: a2.jobId })

    git(root, 'checkout', '-q', 'master')
    git(root, 'checkout', '-q', '-b', 'feature-b')
    commit(root, { 'src/a.ts': lines(4) })
    const b = await ready(s.prepare({ cwd: root, scope: 'master' }))
    expect(b.thread).not.toBe(a1.thread)
    expect((await s.status({ jobId: b.jobId })).job?.threadKey).toMatch(/^base:[0-9a-f]{40}@feature-b$/)
  })

  test('submit --account fills a job without one and leaves a set account alone', async () => {
    const s = service()
    const bare = await ready(s.prepare({ cwd: small(), scope: 'head' }))
    const out = await s.submit({ jobId: bare.jobId, attempt: 1, account: 'work', reply: fakeReviewer(bare.jobDir) })
    expect(out.account).toBe('work')
    expect((await jobRow(bare.jobId)).account).toBe('work')

    const own = await ready(s.prepare({ cwd: small(), scope: 'head', account: 'private' }))
    const done = await s.submit({ jobId: own.jobId, attempt: 1, account: 'work', reply: fakeReviewer(own.jobDir) })
    expect(done.account).toBe('private')
    expect((await jobRow(own.jobId)).account).toBe('private')
  })
})

describe('fix-round routing', () => {
  const sensitive = () => repo({ 'REVIEW.md': REVIEW_MD, 'core/x.ts': lines(2), 'src/a.ts': lines(2) })

  test('a sensitive-only fix round after a deep round routes standard; covered holds; the deep cap counts one', async () => {
    const s = service()
    const root = sensitive()
    const start = git(root, 'rev-parse', 'HEAD')
    write(root, 'core/x.ts', lines(3))
    const r1 = await ready(s.prepare({ cwd: root, account: 'fixround' }))
    expect(r1).toMatchObject({ tier: 'deep', rule: 'sensitive path: core/x.ts' })
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir) })

    write(root, 'core/x.ts', lines(4))
    const r2 = await ready(s.prepare({ cwd: root, account: 'fixround' }))
    expect(r2).toMatchObject({
      round: 2,
      tier: 'standard',
      rule: 'sensitive path: core/x.ts (fix round, thread already deep)',
      decidedBy: 'rule',
    })
    await s.submit({ jobId: r2.jobId, attempt: 1, reply: fakeReviewer(r2.jobDir) })

    commit(root, {}, 'both rounds')
    const cover = await s.covered({ cwd: root, range: `${start}..HEAD` })
    expect(cover.commits[0]).toMatchObject({ required: 'deep', coveredBy: r2.jobId })
    expect(cover.covered).toBe(true)

    const deepToday = await reviewLedger(pool, db.schema).deepCount('fixround', new Date(0), 'none')
    expect(deepToday).toBe(1)
  })

  test('--min deep raises the fix round again', async () => {
    const s = service()
    const root = sensitive()
    write(root, 'core/x.ts', lines(3))
    const r1 = await ready(s.prepare({ cwd: root }))
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir) })
    write(root, 'core/x.ts', lines(4))
    expect(await s.prepare({ cwd: root, min: 'deep' })).toMatchObject({ tier: 'deep', decidedBy: 'caller' })
  })

  test('a thread whose first round was not deep goes deep on a new sensitive path', async () => {
    const s = service()
    const root = sensitive()
    write(root, 'src/a.ts', lines(60))
    const r1 = await ready(s.prepare({ cwd: root }))
    expect(r1.tier).toBe('standard')
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir) })
    write(root, 'core/x.ts', lines(3))
    expect(await s.prepare({ cwd: root })).toMatchObject({ tier: 'deep', rule: 'sensitive path: core/x.ts' })
  })

  test('a round that does not follow the last head is no fix round: a sensitive-only diff stays deep', async () => {
    const s = service()
    const root = sensitive()
    write(root, 'core/x.ts', lines(3))
    const r1 = await ready(s.prepare({ cwd: root, thread: 'rewritten' }))
    expect(r1.tier).toBe('deep')
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir) })
    git(root, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten base') // a new base, r1.head is not its descendant
    write(root, 'core/x.ts', lines(4))
    const r2 = await ready(s.prepare({ cwd: root, thread: 'rewritten' }))
    expect(r2).toMatchObject({ round: 2, tier: 'deep', rule: 'sensitive path: core/x.ts' })
    expect(r2.diffBase).toBe(r2.base)
    expect(r2.base).not.toBe(r1.base)
  })

  test('a deep-by-size fix round stays deep', async () => {
    const s = service()
    const root = sensitive()
    write(root, 'core/x.ts', lines(3))
    const r1 = await ready(s.prepare({ cwd: root }))
    await s.submit({ jobId: r1.jobId, attempt: 1, reply: fakeReviewer(r1.jobDir) })
    write(root, 'src/big.ts', lines(900))
    expect(await s.prepare({ cwd: root })).toMatchObject({
      tier: 'deep',
      rule: '900 changed non-test code lines > 800',
    })
  })
})

describe('prompt fingerprint', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
  const small = () => {
    const root = repo({ 'src/a.ts': lines(2) })
    commit(root, { 'src/a.ts': lines(3) })
    return root
  }
  const agents = (files: Record<string, string>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-rv4-agents-')))
    repos.push(dir)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }
  const fingerprints = async (dir: string) => {
    const s = service({ env: { AGW_REVIEWER_AGENT_DIR: dir } })
    const job = await ready(s.prepare({ cwd: small(), scope: 'head' }))
    const { job: shown } = await s.status({ jobId: job.jobId })
    const row = await jobRow(job.jobId)
    expect([row.reviewer_prompt, row.verifier_prompt]).toEqual([shown?.reviewerPrompt, shown?.verifierPrompt])
    return [shown?.reviewerPrompt, shown?.verifierPrompt]
  }

  test('both files present: the first 12 hex of their sha256', async () => {
    const dir = agents({ 'reviewer.md': 'reviewer v1', 'review-verifier.md': 'verifier v1' })
    expect(await fingerprints(dir)).toEqual([sha('reviewer v1'), sha('verifier v1')])
  })
  test('one missing is null, both missing are null', async () => {
    expect(await fingerprints(agents({ 'reviewer.md': 'reviewer v1' }))).toEqual([sha('reviewer v1'), null])
    expect(await fingerprints(agents({}))).toEqual([null, null])
  })
})

describe('anchoring at submit', () => {
  test('lineValid and anchored are computed and stored; no finding is dropped for them', async () => {
    const s = service()
    const root = repo({ 'src/a.ts': lines(60) })
    write(root, 'src/a.ts', lines(62))
    const job = await ready(s.prepare({ cwd: root }))
    const out = await s.submit({
      jobId: job.jobId,
      attempt: 1,
      reply: fakeReviewer(job.jobDir, [
        { tag: 'important', file: 'src/a.ts', line: 61, message: 'at the change' },
        { tag: 'important', file: 'src/a.ts', line: 1, message: 'far from the change' },
        { tag: 'important', file: 'src/a.ts', line: 999, message: 'beyond the end' },
        { tag: 'important', file: 'src/ghost.ts', line: 1, message: 'no such file' },
        { tag: 'nit', file: 'src/a.ts', line: null, message: 'no line' },
      ]),
    })
    expect(out.findings.map((f) => [f.message, f.lineValid, f.anchored])).toEqual([
      ['at the change', true, true],
      ['far from the change', true, false],
      ['beyond the end', false, false],
      ['no such file', false, false],
      ['no line', undefined, undefined],
    ])
    const rows = await findingRows(job.thread)
    expect(rows.map((r) => [r.line_valid, r.anchored])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, false],
      [null, null],
    ])
  })
})

describe('acceptance criteria', () => {
  const small = async (s: ReturnType<typeof service>) => {
    const root = repo({ 'src/a.ts': lines(2) })
    write(root, 'src/a.ts', lines(3))
    return ready(s.prepare({ cwd: root }))
  }

  test('criteria are stored and returned; a not-met item alone leaves the outcome clean', async () => {
    const s = service()
    const job = await small(s)
    const criteria = [
      { item: 'adds the line', status: 'met', evidence: 'src/a.ts:3' },
      { item: 'documents it', status: 'not-met', evidence: '' },
      { item: 'ships a flag', status: 'unclear' },
    ]
    const out = await s.submit({ jobId: job.jobId, attempt: 1, reply: fakeReviewer(job.jobDir, [], { criteria }) })
    expect(out.outcome).toBe('clean')
    expect(out.criteria).toEqual([
      { item: 'adds the line', status: 'met', evidence: 'src/a.ts:3' },
      { item: 'documents it', status: 'not-met', evidence: '' },
      { item: 'ships a flag', status: 'unclear', evidence: '' },
    ])
    expect((await s.status({ jobId: job.jobId })).job?.output?.criteria).toEqual(out.criteria)
  })

  test('a reply without criteria, or with an empty list, has none in the output', async () => {
    const s = service()
    const without = await small(s)
    expect(
      'criteria' in (await s.submit({ jobId: without.jobId, attempt: 1, reply: fakeReviewer(without.jobDir) })),
    ).toBe(false)
    const empty = await small(s)
    const out = await s.submit({
      jobId: empty.jobId,
      attempt: 1,
      reply: fakeReviewer(empty.jobDir, [], { criteria: [] }),
    })
    expect('criteria' in out).toBe(false)
  })

  test('an unknown criterion status is refused', async () => {
    const s = service()
    const job = await small(s)
    const reply = fakeReviewer(job.jobDir, [], { criteria: [{ item: 'x', status: 'maybe' }] })
    await rejects(s.submit({ jobId: job.jobId, attempt: 1, reply }), /reviewer schema/)
  })
})
