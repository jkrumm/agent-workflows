import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { JournalDb, RUNAWAY_CAP_PREFIX, WALLET_REFUSAL_PREFIX } from '@agent-workflows/middleware'
import { RunawayCapExceeded, walletGate } from '@agent-workflows/limits'
import type { Logger } from '@agent-workflows/runtime'
import { boot, lazyOpenCodeHost } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import {
  DEFAULT_SETTINGS,
  type FrictionSettings,
  frictionSettings,
  frictionStatus,
  type GhPort,
  issueNumber,
  issueTitle,
  markFollowUps,
  RECOUNT_CAP,
  runFrictionJob,
  startFrictionJob,
  workflowFriction,
} from '../src/friction/index.ts'
import { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from '../../runtime/test/support/pg.ts'

const db = freshSchema('hfr')
const sql = inspector(db.schema)
const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger())
const rt = testRuntime({ schema: db.schema, workflows: [] })

beforeAll(async () => {
  await rt.open() // applies the migrations
})
afterAll(async () => {
  await rt.close()
  await journal.close()
  await sql.close()
  await db.drop()
})

const CWD = '/Users/someone/private-repo-marker'
const SECRET = {
  prompt: 'SECRET-PROMPT-TEXT',
  output: 'SECRET-OUTPUT-TEXT',
  error: 'SECRET-ERROR-TEXT',
  scope: 'SECRET-SCOPE-REF',
}

const ZERO = { v: 1, toolErrors: 0, repeatToolCalls: 0, nudges: 0, schemaReasks: 0, overBudget: 0, followUps: 0 }
let seq = 0

type RunSpec = {
  workflow: string
  purpose?: string
  friction?: Record<string, unknown> | null
  /** Minutes before `finished` the run was created; the run ran 1 minute. */
  finishedAgoMin?: number
  input?: Record<string, unknown>
  status?: string
  errorKind?: string
  createdAt?: Date
  /** An exact finish time; the database clock and this process's clock are not the same clock. */
  finishedAt?: Date
  parent?: string
}

/** A finished run with its record delivered, as the platform leaves it. */
async function insertRun(spec: RunSpec): Promise<string> {
  const id = `run-${String(++seq).padStart(5, '0')}`
  const finished = spec.finishedAt ?? new Date(Date.now() - (spec.finishedAgoMin ?? 60) * 60_000)
  const created = spec.createdAt ?? new Date(finished.getTime() - 60_000)
  await sql.pool.query(
    `insert into "${db.schema}".runs (id, workflow, root_id, parent_id, status, purpose, input, input_hash, output, error, lock_key,
       version_started, friction, post_hooks_at, started_at, finished_at, created_at, error_kind)
     values ($1, $2, $1, $3, $4, $5, $6, 'h', $7, $8, $9, 'v1', $10, now(), $11, $12, $11, $13)`,
    [
      id,
      spec.workflow,
      spec.parent ?? null,
      spec.status ?? 'done',
      spec.purpose ?? 'prod',
      JSON.stringify(spec.input ?? { cwd: CWD, scope: SECRET.scope, prompt: SECRET.prompt }),
      JSON.stringify({ text: SECRET.output }),
      SECRET.error,
      seq,
      spec.friction === undefined
        ? JSON.stringify(ZERO)
        : spec.friction === null
          ? null
          : JSON.stringify({ ...ZERO, ...spec.friction }),
      created,
      finished,
      spec.errorKind ?? null,
    ],
  )
  return id
}

/** The database's "now": filed_at and finished_at in production both come from it, a test's own clock may differ. */
async function dbNow(): Promise<Date> {
  return (await sql.pool.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]?.now as Date
}

/** Makes every intent row old enough to be a crash rather than a tick still filing. */
async function age() {
  await sql.pool.query(`update "${db.schema}".friction_issues set filed_at = filed_at - interval '1 hour'`)
}

async function clear() {
  await sql.pool.query(`delete from "${db.schema}".runs`)
  await sql.pool.query(`delete from "${db.schema}".friction_issues`)
}

type FakeIssue = {
  repo: string
  title: string
  body: string
  open: boolean
  closedAt: string | null
  createdAt: string
  deleted?: true
}

function fakeGh() {
  const created: FakeIssue[] = []
  const stateCalls: number[] = []
  const searches: string[] = []
  /** Makes `issueState` throw instead of answering (gh missing, repository unreachable). */
  const failState: { with: Error | null } = { with: null }
  /** Makes `createIssue` create the issue and then fail, as a lost connection after the POST would. */
  const failAfterCreate: { with: Error | null } = { with: null }
  const port: GhPort = {
    async issueState(_repo, number) {
      stateCalls.push(number)
      if (failState.with) throw failState.with
      const issue = created[number - 1]
      if (!issue || issue.deleted) return { state: 'deleted', closedAt: null }
      return { state: issue.open ? 'open' : 'closed', closedAt: issue.closedAt }
    },
    async findIssuesByTitle(repo, title) {
      searches.push(title)
      return created
        .map((c, i) => ({ ...c, number: i + 1 }))
        .filter((c) => c.repo === repo && c.title === title)
        .map((c) => ({
          number: c.number,
          url: `https://example.com/${repo}/issues/${c.number}`,
          createdAt: c.createdAt,
        }))
    },
    async createIssue(repo, title, body) {
      created.push({ repo, title, body, open: true, closedAt: null, createdAt: new Date().toISOString() })
      if (failAfterCreate.with) throw failAfterCreate.with
      return `https://example.com/${repo}/issues/${created.length}`
    },
  }
  const close = (n: number, at: Date) => {
    const issue = created[n - 1]
    if (!issue) return
    issue.open = false
    issue.closedAt = at.toISOString()
  }
  const reopen = (n: number) => {
    const issue = created[n - 1]
    if (!issue) return
    issue.open = true
    issue.closedAt = null
  }
  const remove = (n: number) => {
    const issue = created[n - 1]
    if (issue) issue.deleted = true
  }
  return { port, created, close, reopen, remove, stateCalls, searches, failState, failAfterCreate }
}

/** The ports the rest of the file builds by hand: the same shape, never reached. */
const noSearch: GhPort['findIssuesByTitle'] = async () => []

const settings = (over: Partial<FrictionSettings> = {}): FrictionSettings => ({
  ...DEFAULT_SETTINGS,
  repo: 'owner/name',
  ...over,
})
const run = (
  gh: GhPort,
  over: Partial<FrictionSettings> = {},
  now = new Date('2026-10-28T12:00:00Z'),
  logger: Logger = captureLogger(),
) => runFrictionJob({ db: journal, settings: settings(over), gh, logger, now: () => now })

/** `n` runs of a workflow, `bad` of them with friction. */
async function runs(workflow: string, n: number, bad: number, friction: Record<string, unknown> = { nudges: 2 }) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await insertRun({ workflow, friction: i < bad ? friction : {} }))
  return ids
}

describe('threshold job', () => {
  test('a breach opens one issue with counts, rates and run ids; nothing from the runs leaks into it', async () => {
    await clear()
    const ids = await runs('review', 12, 6, { nudges: 2, toolErrors: 7 })
    await runs('check', 12, 1) // under the rate
    const gh = fakeGh()
    const result = await run(gh.port)
    expect(result.issues).toEqual([
      { workflow: 'review', title: 'Friction: review above threshold', url: 'https://example.com/owner/name/issues/1' },
    ])
    expect(gh.created).toHaveLength(1)
    const { body, repo } = gh.created[0] ?? { body: '', repo: '' }
    expect(repo).toBe('owner/name')
    expect(body).not.toContain('<!--') // nothing hidden in the body to find it by; the record is in the database
    expect(body).toContain('6 of 12 top-level user runs (50%)')
    expect(body).toContain('| `nudges` | 2 | 6 | 12 |')
    expect(body).toContain('| `toolErrors` | 5 | 6 | 42 |')
    for (const id of ids.slice(0, 6)) expect(body).toContain(id)
    for (const id of ids.slice(6)) expect(body).not.toContain(id)
    for (const secret of [CWD, 'private-repo-marker', ...Object.values(SECRET)]) expect(body).not.toContain(secret)
  })

  test('no breach: under the rate, under the minimum of runs, eval runs, runs outside the window, runs without a record, cancelled runs', async () => {
    await clear()
    await runs('rate', 20, 4) // 20% < 25%
    await runs('few', 9, 9) // fewer than 10 runs
    for (let i = 0; i < 12; i++) await insertRun({ workflow: 'evals', purpose: 'eval', friction: { nudges: 3 } })
    for (let i = 0; i < 12; i++)
      await insertRun({ workflow: 'old', friction: { nudges: 3 }, finishedAgoMin: 8 * 24 * 60 })
    for (let i = 0; i < 12; i++)
      await insertRun({ workflow: 'cancelled', status: 'cancelled', friction: { nudges: 3 } })
    await sql.pool.query(`update "${db.schema}".runs set post_hooks_at = null where workflow = 'rate'`)
    const gh = fakeGh()
    const result = await run(gh.port)
    expect(gh.created).toHaveLength(0)
    expect(result.issues).toEqual([])
    expect(result.workflows.map((w) => w.workflow).sort()).toEqual(['few'])
  })

  test('only top-level runs are counted: a fan-out child is part of its parent', async () => {
    await clear()
    const parent = await insertRun({ workflow: 'fan' })
    for (let i = 0; i < 12; i++) await insertRun({ workflow: 'fan.child', parent, friction: { toolErrors: 9 } })
    for (let i = 0; i < 12; i++) await insertRun({ workflow: 'fan', friction: {} })
    const stats = await workflowFriction({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger: captureLogger(),
    })
    expect(stats.map((w) => [w.workflow, w.runs, w.withFriction])).toEqual([['fan', 13, 0]])
  })

  test('while the issue is open the job looks it up by number, files nothing and edits nothing', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    await run(gh.port)
    const later = await run(gh.port, {}, new Date('2026-11-12T08:00:00Z')) // two weeks on, still open
    expect(gh.created).toHaveLength(1)
    expect(gh.stateCalls).toEqual([1])
    expect(later.issues).toEqual([{ workflow: 'review', title: 'Friction: review above threshold', existing: true }])
  })

  test('closing the issue does not re-file the same breach: only runs that finished after the close count', async () => {
    await clear()
    await runs('review', 10, 10) // finished an hour ago
    const gh = fakeGh()
    await run(gh.port)
    gh.close(1, new Date(Date.now() - 30 * 60_000)) // closed 30 minutes ago
    const again = await run(gh.port)
    expect(gh.created).toHaveLength(1)
    expect(again.issues).toEqual([])

    // A few new runs after the close are not enough, they also have to breach (>= 10 runs, >= 25%).
    for (let i = 0; i < 9; i++) await insertRun({ workflow: 'review', finishedAgoMin: 10, friction: { nudges: 2 } })
    expect((await run(gh.port)).issues).toEqual([])
    await insertRun({ workflow: 'review', finishedAgoMin: 10, friction: { nudges: 2 } })
    const refiled = await run(gh.port)
    expect(refiled.issues).toEqual([
      { workflow: 'review', title: 'Friction: review above threshold', url: 'https://example.com/owner/name/issues/2' },
    ])
    expect(gh.created[1]?.body).toContain('10 of 10 top-level user runs (100%) finished since')
    expect(gh.created[1]?.body).toContain('previous issue (#1)')
    // The old runs are not in the new issue's evidence.
    const ids = (
      await sql.pool.query(`select id from "${db.schema}".runs where finished_at < now() - interval '40 minutes'`)
    ).rows.map((r: { id: string }) => r.id)
    for (const id of ids) expect(gh.created[1]?.body).not.toContain(id)
  })

  test('the filed issue is our own record: it survives a restart, and a deleted issue starts the evidence at its filing', async () => {
    await clear()
    await runs('review', 10, 10)
    const first = fakeGh()
    await run(first.port) // files #1 in a first "process"
    const stored = await sql.pool.query(`select repo, number, workflow, closed_at from "${db.schema}".friction_issues`)
    expect(stored.rows).toEqual([{ repo: 'owner/name', number: 1, workflow: 'review', closed_at: null }])

    // A second "process" whose GitHub has no issue #1 any more: deleted. The runs are older than the filing, so they
    // are not new evidence: nothing is filed. The window starts at filed_at, not at "now".
    const gh = fakeGh()
    expect((await run(gh.port, {}, new Date())).issues).toEqual([])
    expect(gh.stateCalls).toEqual([1])
    const closed = await sql.pool.query(
      `select abs(extract(epoch from closed_at - filed_at)) < 0.001 as at_filing from "${db.schema}".friction_issues`,
    )
    expect(closed.rows[0]?.at_filing).toBe(true)

    // Runs that finished after the filing do count: a new issue for new evidence.
    const after = new Date((await dbNow()).getTime() + 1_000)
    for (let i = 0; i < 10; i++) await insertRun({ workflow: 'review', finishedAt: after, friction: { nudges: 2 } })
    const refiled = fakeGh()
    refiled.created.push({
      repo: 'owner/name',
      title: 'x',
      body: '',
      open: true,
      closedAt: null,
      createdAt: '2020-01-01T00:00:00Z',
      deleted: true,
    })
    const result = await run(refiled.port, {}, new Date())
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.url).toBeDefined()
    // The previous issue is gone: the body must not point at it or say it was closed.
    const body = refiled.created[1]?.body ?? ''
    expect(body).toContain('after the previous issue was removed')
    expect(body).not.toContain('#1')
    expect(body).not.toContain('was closed')
  })

  test('only a "no such issue" answer means deleted; any other failure skips the workflow this tick and files nothing', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    await run(gh.port)
    for (const message of [
      'gh: command not found',
      'GraphQL: Could not resolve to a Repository with the name',
      'HTTP 404: Not Found',
    ]) {
      gh.failState.with = new Error(message)
      const logger = captureLogger()
      const result = await run(gh.port, {}, new Date(), logger)
      expect(result.issues).toEqual([])
      expect(logger.lines.some((l) => l.message.startsWith('friction job: could not check or open the issue'))).toBe(
        true,
      )
    }
    expect(gh.created).toHaveLength(1)
    const row = await sql.pool.query(`select closed_at from "${db.schema}".friction_issues`)
    expect(row.rows[0]?.closed_at).toBeNull() // nothing was concluded from the failures
  })

  test('a reopened issue is noticed even after it was recorded closed: the close is cleared and nothing is filed', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    await run(gh.port)
    gh.close(1, new Date(Date.now() - 30 * 60_000))
    await run(gh.port) // records the close
    expect(
      (await sql.pool.query(`select closed_at from "${db.schema}".friction_issues`)).rows[0]?.closed_at,
    ).toBeInstanceOf(Date)

    for (let i = 0; i < 10; i++) await insertRun({ workflow: 'review', finishedAgoMin: 5, friction: { nudges: 2 } }) // new evidence
    gh.reopen(1)
    const result = await run(gh.port)
    expect(gh.created).toHaveLength(1) // not filed again
    expect(result.issues).toEqual([{ workflow: 'review', title: 'Friction: review above threshold', existing: true }])
    expect((await sql.pool.query(`select closed_at from "${db.schema}".friction_issues`)).rows[0]?.closed_at).toBeNull()
  })

  test('filing is not atomic with recording: an intent row survives a crash and the next tick completes it by title, filing nothing twice', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    gh.failAfterCreate.with = new Error('connection lost after the POST')
    const logger = captureLogger()
    await run(gh.port, {}, undefined, logger)
    expect(gh.created).toHaveLength(1) // the issue exists on GitHub
    const intent = await sql.pool.query(`select number, url from "${db.schema}".friction_issues`)
    expect(intent.rows).toEqual([{ number: null, url: null }]) // ... and the record only has the intent

    await age()
    gh.failAfterCreate.with = null
    const next = await run(gh.port, {}, undefined, logger)
    expect(gh.created).toHaveLength(1) // not filed again
    expect(gh.searches).toEqual(['Friction: review above threshold'])
    expect(next.issues).toEqual([{ workflow: 'review', title: 'Friction: review above threshold', existing: true }])
    expect((await sql.pool.query(`select number, url from "${db.schema}".friction_issues`)).rows).toEqual([
      { number: 1, url: 'https://example.com/owner/name/issues/1' },
    ])
  })

  test('an intent whose issue never came into being is dropped and the breach is filed; an older issue of the same title is not mistaken for it', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    // The workflow's previous issue: same title, created long ago, closed long ago (not new evidence for anything).
    gh.created.push({
      repo: 'owner/name',
      title: 'Friction: review above threshold',
      body: '',
      open: false,
      closedAt: '2020-01-02T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
    })
    await sql.pool.query(`insert into "${db.schema}".friction_issues (repo, workflow) values ('owner/name', 'review')`)
    await age()
    const result = await run(gh.port)
    expect(gh.searches).toHaveLength(1)
    expect(gh.created).toHaveLength(2) // filed a fresh one
    expect(result.issues[0]?.url).toBe('https://example.com/owner/name/issues/2')
    const rows = await sql.pool.query(`select number from "${db.schema}".friction_issues order by id`)
    expect(rows.rows).toEqual([{ number: 2 }]) // the orphan intent is gone
  })

  test('a fresh intent belongs to a tick that is still filing: this tick leaves it alone and files nothing', async () => {
    await clear()
    await runs('review', 10, 10)
    await sql.pool.query(`insert into "${db.schema}".friction_issues (repo, workflow) values ('owner/name', 'review')`)
    const gh = fakeGh()
    const logger = captureLogger()
    const result = await run(gh.port, {}, undefined, logger)
    expect(gh.created).toHaveLength(0)
    expect(gh.searches).toHaveLength(0)
    expect(result.issues).toEqual([{ workflow: 'review', title: 'Friction: review above threshold', existing: true }])
    expect(logger.lines.some((l) => l.message.includes('another run is filing this workflow'))).toBe(true)
  })

  test('two ticks racing to file the same workflow: the second intent hits the unique index and skips', async () => {
    await clear()
    await runs('review', 10, 10)
    // A competing tick inserts its intent between our lookup and our own insert.
    let raced = false
    const spy = {
      runs: journal.runs,
      pool: {
        query: async (text: string, params?: unknown[]) => {
          if (!raced && /insert into .*friction_issues \(repo, workflow\)/s.test(text)) {
            raced = true
            await journal.pool.query(
              `insert into "${db.schema}".friction_issues (repo, workflow) values ('owner/name', 'review')`,
            )
          }
          return journal.pool.query(text, params)
        },
      },
    } as unknown as typeof journal
    const gh = fakeGh()
    const logger = captureLogger()
    const result = await runFrictionJob({ db: spy, settings: settings(), gh: gh.port, logger })
    expect(raced).toBe(true)
    expect(gh.created).toHaveLength(0) // we did not file
    expect(result.issues).toEqual([{ workflow: 'review', title: 'Friction: review above threshold', existing: true }])
    expect(logger.lines.some((l) => l.message.includes('another run is filing this workflow'))).toBe(true)
    // The index itself: a second unfinished intent for the workflow is refused by the database.
    const second = await sql.pool
      .query(`insert into "${db.schema}".friction_issues (repo, workflow) values ('owner/name', 'review')`)
      .then(
        () => null,
        (err: unknown) => err as { code?: string },
      )
    expect(second?.code).toBe('23505')
  })

  test('an issue filed with an unreadable URL leaves its intent, and the next tick finds it by title instead of filing again', async () => {
    await clear()
    await runs('review', 10, 10)
    const logger = captureLogger()
    const gh = fakeGh()
    const odd: GhPort = {
      ...gh.port,
      createIssue: async (repo, title, body) => {
        await gh.port.createIssue(repo, title, body)
        return 'not a url'
      },
    }
    const result = await run(odd, {}, undefined, logger)
    expect(result.issues).toHaveLength(1)
    expect(
      logger.lines.some((l) => l.message.startsWith('friction job: an issue was filed but could not be recorded')),
    ).toBe(true)
    await age()
    await run(gh.port)
    expect(gh.created).toHaveLength(1)
    expect((await sql.pool.query(`select number from "${db.schema}".friction_issues`)).rows).toEqual([{ number: 1 }])
  })

  test('the job never creates its table: it is a migration', async () => {
    await clear()
    await runs('review', 10, 10)
    const texts: string[] = []
    const spy = {
      runs: journal.runs,
      pool: {
        query: (text: string, params?: unknown[]) => {
          texts.push(text)
          return journal.pool.query(text, params)
        },
      },
    } as unknown as typeof journal
    await runFrictionJob({ db: spy, settings: settings(), gh: fakeGh().port, logger: captureLogger() })
    expect(texts.some((t) => /create (table|index)/i.test(t))).toBe(false)
    // And only the counters of the friction document are read for the rates, not its per-session detail.
    expect(texts.some((t) => t.includes("friction - 'sessions' - 'events'"))).toBe(true)
  })

  test('only user traffic counts: build, verify and eval runs are not asks', async () => {
    await clear()
    for (const purpose of ['build', 'verify', 'eval']) {
      for (let i = 0; i < 12; i++) await insertRun({ workflow: purpose, purpose, friction: { nudges: 3 } })
    }
    await runs('real', 10, 0)
    for (let i = 0; i < 20; i++) await insertRun({ workflow: 'real', purpose: 'build' }) // would dilute a rate if counted
    const stats = await workflowFriction({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger: captureLogger(),
    })
    expect(stats.map((w) => [w.workflow, w.runs])).toEqual([['real', 10]])
  })

  test('each default limit alone is enough to flag a run, and one below it is not', async () => {
    const limits = DEFAULT_SETTINGS.limits
    for (const [counter, limit] of Object.entries(limits)) {
      if (limit === null) continue
      await clear()
      for (let i = 0; i < 10; i++) await insertRun({ workflow: 'at', friction: { [counter]: limit } })
      for (let i = 0; i < 10; i++) await insertRun({ workflow: 'below', friction: { [counter]: limit - 1 } })
      const stats = await workflowFriction({
        db: journal,
        settings: settings(),
        gh: fakeGh().port,
        logger: captureLogger(),
      })
      expect(Object.fromEntries(stats.map((w) => [w.workflow, w.withFriction]))).toEqual({ at: 10, below: 0 })
    }
  })

  test('a single nudge is not friction; two different calls repeated 3 times (two nudges, repeat 3) are', async () => {
    await clear()
    for (let i = 0; i < 10; i++) await insertRun({ workflow: 'one', friction: { nudges: 1, repeatToolCalls: 3 } })
    for (let i = 0; i < 10; i++) await insertRun({ workflow: 'two', friction: { nudges: 2, repeatToolCalls: 3 } })
    const stats = await workflowFriction({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger: captureLogger(),
    })
    expect(Object.fromEntries(stats.map((w) => [w.workflow, w.withFriction]))).toEqual({ one: 0, two: 10 })
  })

  test('a limit that is off (null) never flags and prints as "off", not as Infinity', async () => {
    await clear()
    await runs('review', 10, 10, { nudges: 5, toolErrors: 9 })
    const gh = fakeGh()
    await run(gh.port, { limits: { ...DEFAULT_SETTINGS.limits, nudges: null } })
    const body = gh.created[0]?.body ?? ''
    expect(body).toContain('| `nudges` | off | 0 | 50 |')
    expect(body).toContain('| `toolErrors` | 5 | 10 | 90 |')
    expect(body).not.toContain('Infinity')
    // With toolErrors off as well, nothing is left to flag these runs.
    const quiet = fakeGh()
    await clear()
    await runs('review', 10, 10, { nudges: 5, toolErrors: 9 })
    await run(quiet.port, { limits: { ...DEFAULT_SETTINGS.limits, nudges: null, toolErrors: null } })
    expect(quiet.created).toHaveLength(0)
  })

  test('thresholds are configurable; a limit raises or lowers what counts', async () => {
    await clear()
    await runs('review', 10, 10, { toolErrors: 3 })
    const strict = fakeGh()
    await run(strict.port, { limits: { ...DEFAULT_SETTINGS.limits, toolErrors: 3 } })
    expect(strict.created).toHaveLength(1)
    const lax = fakeGh()
    await run(lax.port) // default limit 5: three errors are not friction
    expect(lax.created).toHaveLength(0)
    const rare = fakeGh()
    await run(rare.port, { limits: { ...DEFAULT_SETTINGS.limits, toolErrors: 3 }, minRuns: 11 })
    expect(rare.created).toHaveLength(0)
  })

  test('a gh failure is logged and the other workflows still get their issue; no repo opens nothing', async () => {
    await clear()
    await runs('a', 10, 10)
    await runs('b', 10, 10)
    const created: string[] = []
    const logger = captureLogger()
    const flaky: GhPort = {
      issueState: async () => ({ state: 'open', closedAt: null }),
      findIssuesByTitle: noSearch,
      createIssue: async (_repo, title) => {
        if (title.includes(': a ')) throw new Error('gh issue create exited 1')
        created.push(title)
        return `https://example.com/owner/name/issues/${created.length}`
      },
    }
    await run(flaky, {}, undefined, logger)
    expect(created).toEqual(['Friction: b above threshold'])
    expect(logger.lines.some((l) => l.message.startsWith('friction job: could not check or open the issue'))).toBe(true)

    const gh = fakeGh()
    const quiet = captureLogger()
    await run(gh.port, { repo: undefined }, undefined, quiet)
    expect(gh.created).toHaveLength(0)
    expect(quiet.lines.some((l) => l.message.includes('AGW_FRICTION_REPO is unset'))).toBe(true)
  })

  test('the daily timer runs the job and closes', async () => {
    await clear()
    await runs('review', 10, 10)
    const gh = fakeGh()
    const job = startFrictionJob({
      db: journal,
      settings: settings(),
      gh: gh.port,
      logger: captureLogger(),
      firstDelayMs: 10,
      intervalMs: 60_000,
    })
    await until(() => gh.created.length > 0, 'the first job run')
    await job.close()
  })

  test('close() aborts the job and waits a bounded time, however long gh would take', async () => {
    await clear()
    await runs('review', 10, 10)
    let aborted = false
    const hanging: GhPort = {
      issueState: async () => ({ state: 'open', closedAt: null }),
      findIssuesByTitle: noSearch,
      createIssue: (_repo, _title, _body, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(signal.reason)
          })
        }),
    }
    const job = startFrictionJob({
      db: journal,
      settings: settings(),
      gh: hanging,
      logger: captureLogger(),
      firstDelayMs: 10,
      closeWaitMs: 2_000,
    })
    await Bun.sleep(300) // the job is inside createIssue
    const started = Date.now()
    await job.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(aborted).toBe(true)

    // A gh that ignores the signal still cannot hold shutdown past the cap.
    const deaf: GhPort = {
      issueState: async () => ({ state: 'open', closedAt: null }),
      findIssuesByTitle: noSearch,
      createIssue: () => new Promise<string>(() => {}),
    }
    const stubborn = startFrictionJob({
      db: journal,
      settings: settings(),
      gh: deaf,
      logger: captureLogger(),
      firstDelayMs: 10,
      closeWaitMs: 200,
    })
    await Bun.sleep(300)
    const t0 = Date.now()
    await stubborn.close()
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('incomplete counts are recounted before the rates', () => {
  const incomplete = { incomplete: true, toolErrors: 0 }

  test('incomplete runs of the window are recounted, newest first, at most RECOUNT_CAP per run of the job', async () => {
    await clear()
    const ids: string[] = []
    for (let i = 0; i < RECOUNT_CAP + 5; i++) ids.push(await insertRun({ workflow: 'review', friction: incomplete }))
    await insertRun({ workflow: 'review', friction: incomplete, finishedAgoMin: 8 * 24 * 60 }) // outside the window
    await insertRun({ workflow: 'review', friction: incomplete, purpose: 'build' }) // not user traffic
    const asked: string[] = []
    const result = await runFrictionJob({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger: captureLogger(),
      recount: async (runId) => {
        asked.push(runId)
        await sql.pool.query(
          `update "${db.schema}".runs set friction = '{"v":1,"toolErrors":9,"repeatToolCalls":0,"nudges":0,"nudgesMissed":0,"schemaReasks":0,"overBudget":0,"followUps":0}'::jsonb where id = $1`,
          [runId],
        )
      },
    })
    expect(result.recounted).toBe(RECOUNT_CAP)
    expect(asked).toHaveLength(RECOUNT_CAP)
    // Newest first: the run inserted last is asked about first.
    expect(asked[0]).toBe(ids.at(-1))
    // Rates were computed after the recount: the recounted runs now show their tool errors.
    const review = result.workflows.find((w) => w.workflow === 'review')
    expect(review?.counters.toolErrors.runs).toBe(RECOUNT_CAP)
  })

  test('a run that keeps failing cannot hold the head of the cap: fewest attempts first, gave-up runs never', async () => {
    await clear()
    const stuck = await insertRun({ workflow: 'review', friction: { incomplete: true, recountAttempts: 2 } }) // newest of all
    await insertRun({ workflow: 'review', friction: { incomplete: 'gave-up', recountAttempts: 3 } })
    const fresh: string[] = []
    for (let i = 0; i < RECOUNT_CAP; i++) fresh.push(await insertRun({ workflow: 'review', friction: incomplete }))
    const asked: { id: string; retry?: boolean }[] = []
    // Inserted last so it is the newest: without the ordering it would head the cap.
    const newestStuck = await insertRun({ workflow: 'review', friction: { incomplete: true, recountAttempts: 2 } })
    await runFrictionJob({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger: captureLogger(),
      recount: async (id, options) => {
        asked.push({ id, retry: options?.retry })
      },
    })
    expect(asked).toHaveLength(RECOUNT_CAP)
    expect(asked.every((a) => a.retry === true)).toBe(true) // the job asks again, the recounter counts the attempt
    expect(asked.map((a) => a.id)).not.toContain(stuck)
    expect(asked.map((a) => a.id)).not.toContain(newestStuck)
    expect(new Set(asked.map((a) => a.id))).toEqual(new Set(fresh))
  })

  test('a run that cannot be recounted stays flagged and does not stop the job', async () => {
    await clear()
    const id = await insertRun({ workflow: 'review', friction: incomplete })
    const logger = captureLogger()
    const result = await runFrictionJob({
      db: journal,
      settings: settings(),
      gh: fakeGh().port,
      logger,
      recount: async () => {
        throw new Error('opencode is down')
      },
    })
    expect(result.recounted).toBe(0)
    expect(logger.lines.some((l) => l.message.startsWith('friction job: a run could not be recounted'))).toBe(true)
    expect(((await sql.run(id))?.friction as { incomplete?: boolean } | undefined)?.incomplete).toBe(true)
  })
})

describe('follow-ups', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
  const followUpOf = async (id: string) => ((await sql.run(id))?.friction as { followUps?: number } | null)?.followUps

  test('a new run of the same workflow, cwd and scope within 10 minutes of a finished one counts on the earlier run', async () => {
    await clear()
    const first = await insertRun({ workflow: 'review', finishedAgoMin: 30 })
    const second = await insertRun({ workflow: 'review', finishedAgoMin: 20, createdAt: at(25) }) // 5 min after `first` finished
    const lateAfter = await insertRun({ workflow: 'check', finishedAgoMin: 60 })
    await insertRun({ workflow: 'check', finishedAgoMin: 20, createdAt: at(40) }) // 20 min later
    const otherScope = await insertRun({ workflow: 'wf', finishedAgoMin: 60, input: { cwd: CWD, scope: 'a' } })
    await insertRun({ workflow: 'wf', finishedAgoMin: 50, createdAt: at(57), input: { cwd: CWD, scope: 'b' } })
    const otherCwd = await insertRun({ workflow: 'wf2', finishedAgoMin: 60, input: { cwd: '/a' } })
    await insertRun({ workflow: 'wf2', finishedAgoMin: 50, createdAt: at(57), input: { cwd: '/b' } })
    const evalFirst = await insertRun({ workflow: 'ev', finishedAgoMin: 60, purpose: 'eval' })
    await insertRun({ workflow: 'ev', finishedAgoMin: 50, createdAt: at(57), purpose: 'eval' })
    const noCwd = await insertRun({ workflow: 'smoke', finishedAgoMin: 60, input: { text: 'x' } })
    await insertRun({ workflow: 'smoke', finishedAgoMin: 50, createdAt: at(57), input: { text: 'x' } })
    const failedFirst = await insertRun({ workflow: 'rerun', finishedAgoMin: 60, status: 'failed' }) // a retry, not a follow-up
    await insertRun({ workflow: 'rerun', finishedAgoMin: 50, createdAt: at(57) })
    const cancelledLater = await insertRun({ workflow: 'cx', finishedAgoMin: 60 })
    await insertRun({ workflow: 'cx', finishedAgoMin: 50, createdAt: at(57), status: 'cancelled' })
    const refusedLater = await insertRun({ workflow: 'rf', finishedAgoMin: 60 })
    await insertRun({
      workflow: 'rf',
      finishedAgoMin: 50,
      createdAt: at(57),
      status: 'failed',
      errorKind: 'admission_refused',
    })
    const buildFirst = await insertRun({ workflow: 'bd', finishedAgoMin: 60, purpose: 'build' }) // not a user call
    await insertRun({ workflow: 'bd', finishedAgoMin: 50, createdAt: at(57), purpose: 'build' })
    const verifyLater = await insertRun({ workflow: 'vf', finishedAgoMin: 60 })
    await insertRun({ workflow: 'vf', finishedAgoMin: 50, createdAt: at(57), purpose: 'verify' })
    const before = await insertRun({ workflow: 'ord', finishedAgoMin: 5 }) // the "follow-up" started BEFORE it finished
    await insertRun({ workflow: 'ord', finishedAgoMin: 1, createdAt: at(8) })

    const deps = { db: journal, settings: settings(), gh: fakeGh().port, logger: captureLogger() }
    expect(await markFollowUps(deps)).toBe(1 + 0)
    expect(await followUpOf(first)).toBe(1)
    for (const id of [
      second,
      lateAfter,
      otherScope,
      otherCwd,
      evalFirst,
      noCwd,
      before,
      failedFirst,
      cancelledLater,
      refusedLater,
      buildFirst,
      verifyLater,
    ])
      expect(await followUpOf(id)).toBe(0)
    expect(await markFollowUps(deps)).toBe(0) // idempotent
    expect((await sql.run(first))?.friction).toMatchObject({ v: 1, followUps: 1, nudges: 0 })
  })

  test('a window in fractions of a minute works', async () => {
    await clear()
    const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000)
    const quick = await insertRun({ workflow: 'q', finishedAgoMin: 10, input: { cwd: '/a' } }) // finished 10 min ago
    await insertRun({ workflow: 'q', finishedAgoMin: 1, createdAt: at(600 - 20), input: { cwd: '/a' } }) // 20 s later
    const slow = await insertRun({ workflow: 'q2', finishedAgoMin: 10, input: { cwd: '/b' } })
    await insertRun({ workflow: 'q2', finishedAgoMin: 1, createdAt: at(600 - 40), input: { cwd: '/b' } }) // 40 s later
    const deps = {
      db: journal,
      settings: settings({ followUpMinutes: 0.5 }),
      gh: fakeGh().port,
      logger: captureLogger(),
    }
    expect(await markFollowUps(deps)).toBe(1)
    const marked = async (id: string) => ((await sql.run(id))?.friction as { followUps?: number } | null)?.followUps
    expect(await marked(quick)).toBe(1)
    expect(await marked(slow)).toBe(0)
  })

  test('followUps counts toward the rate, so enough of them open an issue', async () => {
    await clear()
    const gh = fakeGh()
    for (let i = 0; i < 10; i++) {
      const cwd = `/work/${i}`
      await insertRun({ workflow: 'check', finishedAgoMin: 120, input: { cwd } })
      await insertRun({ workflow: 'check', finishedAgoMin: 100, createdAt: at(115), input: { cwd } })
    }
    const result = await run(gh.port)
    expect(result.followUps).toBe(10)
    expect(gh.created[0]?.body).toContain('| `followUps` | 1 | 10 | 10 |')
  })
})

describe('configuration', () => {
  const base = { AGW_API_SECRET: 'x'.repeat(40), AGW_MACHINE: 'm', AGW_PG_URL: 'postgres://example' }

  test('on in production by default, off by flag, off for a literal test config', () => {
    expect(loadConfig(base).friction?.enabled).toBe(true)
    expect(loadConfig({ ...base, AGW_FRICTION_ISSUES: 'off' }).friction).toMatchObject({
      enabled: false,
      disabledReason: 'AGW_FRICTION_ISSUES is off',
    })
    expect(loadConfig({ ...base, AGW_FRICTION_ISSUES: '0' }).friction?.enabled).toBe(false)
  })

  test('a fractional follow-up window is accepted', () => {
    const parsed = frictionSettings({ AGW_FRICTION_CONFIG: '{"followUpMinutes":2.5}' })
    expect(parsed.problems).toEqual([])
    expect(parsed.settings.followUpMinutes).toBe(2.5)
  })

  test('repo and overrides are validated, every problem named', () => {
    const ok = frictionSettings({
      AGW_FRICTION_REPO: 'owner/name',
      AGW_FRICTION_CONFIG: '{"rate":0.5,"minRuns":3,"limits":{"toolErrors":2}}',
    })
    expect(ok.problems).toEqual([])
    expect(ok.settings).toMatchObject({
      repo: 'owner/name',
      rate: 0.5,
      minRuns: 3,
      limits: { ...DEFAULT_SETTINGS.limits, toolErrors: 2 },
    })
    const bad = frictionSettings({ AGW_FRICTION_REPO: 'not a repo', AGW_FRICTION_CONFIG: '{"rate":2,"typo":1}' })
    expect(bad.problems).toHaveLength(2)
    expect(frictionSettings({ AGW_FRICTION_CONFIG: '{' }).problems).toEqual(['AGW_FRICTION_CONFIG is not valid JSON'])
    // Advisory: a bad optional setting disables the job and never stops the host.
    const errors = console.error
    console.error = () => {}
    try {
      expect(loadConfig({ ...base, AGW_FRICTION_REPO: 'nope' }).friction).toMatchObject({
        enabled: false,
        disabledReason: 'AGW_FRICTION_REPO must be owner/name',
      })
      expect(loadConfig({ ...base, AGW_FRICTION_ISSUES: 'off', AGW_FRICTION_CONFIG: '{' }).friction?.enabled).toBe(
        false,
      )
    } finally {
      console.error = errors
    }
    // `null` switches a counter off.
    expect(
      frictionSettings({ AGW_FRICTION_CONFIG: '{"limits":{"nudges":null,"toolErrors":9}}' }).settings.limits,
    ).toMatchObject({
      nudges: null,
      toolErrors: 9,
      repeatToolCalls: 5,
    })
  })
})

describe('the money rules the counters recognise', () => {
  test('the prefixes are the ones the real wallet gate and runaway cap produce', async () => {
    const cap = new RunawayCapExceeded('cost', 2, 1, { kind: 'static', sample: 0, reason: 'below_sample_minimum' })
    expect(cap.message.startsWith(RUNAWAY_CAP_PREFIX)).toBe(true)
    expect(cap.kind).toBe('middleware')
    const gate = walletGate({
      workflows: ['ocr'],
      pausedUntil: new Date('2099-01-01T00:00:00Z'),
      logger: captureLogger(),
    })
    const info = {
      runId: 'r',
      workflowId: 'ocr',
      version: 'v1',
      purpose: 'prod',
      parentId: null,
      rootId: 'r',
      input: {},
      traceparent: null,
      resume: false,
    }
    const refusal = await Promise.resolve(gate.runPre?.(info)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(refusal?.name).toBe('AdmissionRefused')
    expect(refusal?.message.startsWith(WALLET_REFUSAL_PREFIX)).toBe(true)
  })
})

describe('naming and the counters source', () => {
  test('a stable title per workflow; the number comes out of the URL gh prints', () => {
    expect(issueTitle('review')).toBe('Friction: review above threshold')
    expect(issueNumber('https://github.com/owner/name/issues/42\n')).toBe(42)
    expect(() => issueNumber('nothing')).toThrow('no issue URL')
  })

  test('the lazy OpenCode host builds on demand to count the sessions of a run it did not drive (resume after a restart)', async () => {
    let built = 0
    const lazy = lazyOpenCodeHost({}, () => undefined, {
      createServer: () => {
        built++
        throw new Error('the server would be built here')
      },
    })
    const failure = await lazy.stepSessions({ runId: 'r', stepId: 's' }).catch((err: unknown) => err)
    expect((failure as Error).message).toContain('would be built')
    expect(built).toBe(1)
    await lazy.close()
  })
})

describe('the running host says whether the friction job is on', () => {
  const env = (schema: string, extra: Record<string, string> = {}) => ({
    AGW_API_SECRET: 'test-secret-0123456789abcdef-0123456789',
    AGW_MACHINE: 'test-machine',
    AGW_PG_URL: PG_URL,
    AGW_PG_SCHEMA: schema,
    AGW_PORT: '0',
    IU_API_KEY: 'test-key',
    ...extra,
  })

  test('/health serves a state and never the reason; the reason stays on the host and in its log', async () => {
    const quiet = { error: console.error, warn: console.warn }
    console.error = () => {}
    console.warn = () => {}
    const fresh = freshSchema('hfrboot')
    try {
      const health = async (port: number) =>
        (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { status: string; friction?: unknown }
      const on = await boot(loadConfig(env(fresh.schema, { AGW_FRICTION_REPO: 'owner/name' })))
      expect(on.friction).toEqual({ enabled: true, state: 'on' })
      expect(await health(on.port)).toMatchObject({ status: 'ok', friction: { enabled: true, state: 'on' } })
      await on.shutdown()

      // Enabled but with nowhere to file: working is not the same thing as on.
      const noRepo = await boot(loadConfig(env(fresh.schema)))
      expect(noRepo.friction).toMatchObject({ enabled: true, state: 'no-repo' })
      expect((await health(noRepo.port)).friction).toEqual({ enabled: true, state: 'no-repo' })
      await noRepo.shutdown()

      const off = await boot(loadConfig(env(fresh.schema, { AGW_FRICTION_ISSUES: 'off' })))
      expect(off.friction).toEqual({ enabled: false, state: 'off', reason: 'AGW_FRICTION_ISSUES is off' })
      expect((await health(off.port)).friction).toEqual({ enabled: false, state: 'off' })
      await off.shutdown()

      const bad = await boot(loadConfig(env(fresh.schema, { AGW_FRICTION_CONFIG: '{"rate":2}' })))
      expect(bad.friction).toMatchObject({ enabled: false, state: 'misconfigured' })
      expect(bad.friction.reason).toContain('AGW_FRICTION_CONFIG') // in this process, for its log
      const badHealth = await health(bad.port) // up
      expect(badHealth.status).toBe('ok')
      expect(badHealth.friction).toEqual({ enabled: false, state: 'misconfigured' }) // the unauthenticated body names no setting
      expect(JSON.stringify(badHealth)).not.toContain('AGW_FRICTION')
      await bad.shutdown()
    } finally {
      console.error = quiet.error
      console.warn = quiet.warn
      await fresh.drop()
    }
  })

  test('frictionStatus: one state per situation', () => {
    const base = { ...DEFAULT_SETTINGS, repo: 'owner/name' }
    expect(frictionStatus(undefined)).toMatchObject({ enabled: false, state: 'off' })
    expect(frictionStatus(base)).toEqual({ enabled: true, state: 'on' })
    expect(frictionStatus({ ...base, repo: undefined })).toMatchObject({ enabled: true, state: 'no-repo' })
    expect(frictionStatus({ ...base, enabled: false })).toMatchObject({ enabled: false, state: 'off' })
    expect(frictionStatus({ ...base, enabled: false, misconfigured: true })).toMatchObject({ state: 'misconfigured' })
  })
})
