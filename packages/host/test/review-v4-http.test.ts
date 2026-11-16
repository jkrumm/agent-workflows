import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertValues, coerceStdin, parseArgs } from '../../cli/src/args.ts'
import { buildCommands, resolveCommand } from '../../cli/src/spec.ts'
import { createReviewService, type ReviewService, reviewOperations } from '../src/review/index.ts'
import { gitRunner } from '../src/review/route.ts'
import { startTestHost, type TestHost } from './support.ts'
import { fakeReviewer, lines, makeRepo, write } from './support/review-repo.ts'

let t: TestHost
let service: ReviewService
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'agw-rv4-http-')))
let root: string
/** The service needs the host's schema, which exists once the host does: the operations delegate. */
let prepareFailure: Error | null = null
const late: ReviewService = {
  prepare: (i) => (prepareFailure ? Promise.reject(prepareFailure) : service.prepare(i)),
  submit: (i) => service.submit(i),
  dispose: (i) => service.dispose(i),
  status: (i) => service.status(i),
  route: (i) => service.route(i),
  cancel: (i) => service.cancel(i),
  covered: (i) => service.covered(i),
  stats: (i) => service.stats(i),
}

beforeAll(async () => {
  t = await startTestHost({ prefix: 'rv4http', reads: reviewOperations(late) })
  service = createReviewService({ pool: t.pool, schema: t.schema, stateDir, git: gitRunner })
  root = makeRepo({ 'src/a.ts': lines(2) })
})
afterAll(async () => {
  await t.close()
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

/** argv through the generated CLI's parser, then the request the CLI sends. */
async function agw(argv: string[], stdin?: string) {
  const { commands } = buildCommands(await t.host.openapi())
  const resolved = resolveCommand(commands, argv)
  if (!resolved) throw new Error(`no command for ${argv.join(' ')}`)
  const { command, rest } = resolved
  const { values } = parseArgs(command, rest)
  if (stdin !== undefined && command.x.stdin) values[command.x.stdin] = coerceStdin(command, stdin)
  assertValues(command, values)
  return { command, ...(await t.json(await t.call(command.path, { method: 'POST', body: values }))) }
}

describe('agw review prepare → submit through the host', () => {
  test('the review commands carry their CLI contract', async () => {
    const { commands } = buildCommands(await t.host.openapi())
    const x = (words: string) => commands.find((c) => c.words.join(' ') === words)?.x
    expect(x('review')).toBeUndefined() // `agw review` itself is not a command: only its subcommands are
    expect(x('review prepare')).toMatchObject({ mutating: true, defaultFormat: 'json', positional: [] })
    expect(x('review submit')).toMatchObject({ mutating: true, positional: ['jobId'], stdin: 'reply' })
    expect(x('review dispose')).toMatchObject({ positional: ['jobId', 'findingId', 'disposition'] })
    expect(x('review status')).toMatchObject({ mutating: false, positional: ['jobId'] })
    expect(x('review route')).toBeDefined()
    expect(commands.find((c) => c.words.join(' ') === 'review route')?.path).toBe('/review/route')
    expect(x('review covered')).toBeDefined()
    expect(x('review stats')).toMatchObject({ mutating: false, defaultFormat: 'json', positional: [] })
    expect(commands.find((c) => c.words.join(' ') === 'review stats')?.path).toBe('/review/stats')
  })

  test('prepare, the fake reviewer, submit; a bad submit is a 400 naming the cause', async () => {
    write(root, 'src/a.ts', lines(3))
    const prepared = await agw(['review', 'prepare', '--cwd', root, '--context', 'one more line'])
    expect(prepared.command.words).toEqual(['review', 'prepare'])
    expect(prepared.status).toBe(200)
    expect(prepared.body).toMatchObject({ status: 'ready', round: 1, tier: 'light', ceiling: 'unjudged' })
    const { jobId, jobDir } = prepared.body

    const submitted = await agw(['review', 'submit', jobId, '--attempt', '1'], fakeReviewer(jobDir))
    expect(submitted.status).toBe(200)
    expect(submitted.body).toMatchObject({
      schemaVersion: 4,
      jobId,
      outcome: 'clean',
      summary: 'Nothing needs fixing.',
    })

    const status = await agw(['review', 'status', jobId])
    expect(status.body.job).toMatchObject({ id: jobId, state: 'submitted' })

    const unknown = await agw(['review', 'submit', 'rv_nope', '--attempt', '1'], '{}')
    expect(unknown.status).toBe(400)
    expect(unknown.body.message).toMatch(/unknown job rv_nope/)
  })

  test('submit, dispose and cancel accept --cwd and ignore it; dispose takes several ids and --all-open', async () => {
    write(root, 'src/a.ts', lines(4))
    const prepared = await agw(['review', 'prepare', '--cwd', root, '--thread', 'dispose-batch'])
    const { jobId, jobDir, thread } = prepared.body
    const reply = fakeReviewer(jobDir, [
      { tag: 'important', file: 'src/a.ts', message: 'first problem' },
      { tag: 'important', file: 'src/a.ts', message: 'second problem' },
      { tag: 'nit', file: 'src/a.ts', message: 'a nit' },
    ])
    const submitted = await agw(['review', 'submit', '--cwd', root, jobId, '--attempt', '1'], reply)
    expect(submitted.status).toBe(200)
    expect(submitted.body.findings).toHaveLength(3)

    const batch = await agw(['review', 'dispose', '--cwd', root, jobId, `${thread}-1,${thread}-2`, 'fixed'])
    expect(batch.status).toBe(200)
    expect(batch.body.disposed.map((f: { id: string; disposition: string }) => [f.id, f.disposition])).toEqual([
      [`${thread}-1`, 'fixed'],
      [`${thread}-2`, 'fixed'],
    ])

    const single = await agw(['review', 'dispose', jobId, `${thread}-3`, 'wrong', '--reason', 'not a bug'])
    expect(single.body).toMatchObject({ id: `${thread}-3`, disposition: 'wrong', reason: 'not a bug' })

    const refused = await agw(['review', 'dispose', jobId, `${thread}-1,${thread}-nope`, 'open'])
    expect(refused.status).toBe(400)
    expect(refused.body.message).toMatch(/finding .*-nope is not in the thread/)
    const unchanged = await agw(['review', 'status', jobId])
    expect(unchanged.body.findings.map((f: { disposition: string }) => f.disposition)).toEqual([
      'fixed',
      'fixed',
      'wrong',
    ])

    // --all-open disposes what is still open, here after the first two were reopened
    await agw(['review', 'dispose', jobId, `${thread}-1,${thread}-2`, 'open'])
    const all = await agw(['review', 'dispose', '--cwd', root, jobId, '--all-open', 'fixed'])
    expect(all.status).toBe(200)
    expect(all.body.disposed.map((f: { id: string }) => f.id)).toEqual([`${thread}-1`, `${thread}-2`])

    write(root, 'src/a.ts', lines(5))
    const next = await agw(['review', 'prepare', '--cwd', root, '--thread', 'cancel-cwd'])
    const cancelled = await agw(['review', 'cancel', '--cwd', root, next.body.jobId])
    expect(cancelled.body).toEqual({ status: 'cancelled', jobId: next.body.jobId })
  })

  test('a role at its connection limit is a retryable 503, any other throw the opaque 500', async () => {
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      prepareFailure = Object.assign(new Error('too many connections for role "agent_workflows"'), { code: '53300' })
      const exhausted = await agw(['review', 'prepare', '--cwd', root])
      expect(exhausted.status).toBe(503)
      expect(exhausted.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', defined: false })
      expect(exhausted.body.message).toMatch(/connection limit; retry/)

      prepareFailure = new Error('journal: too many connections for role "agent_workflows"') // a wrapper dropped the code
      expect((await agw(['review', 'prepare', '--cwd', root])).status).toBe(503)

      prepareFailure = new Error('git clone: exit 128')
      const other = await agw(['review', 'prepare', '--cwd', root])
      expect(other.status).toBe(500)
      expect(logged.some((l) => String(l[0]).includes('review prepare failed') && l[1] === prepareFailure)).toBe(true)
    } finally {
      console.error = original
      prepareFailure = null
    }
  })

  test('stats answers over HTTP through the CLI parser; a bad --since is a 400', async () => {
    const stats = await agw(['review', 'stats', '--by', 'rule'])
    expect(stats.status).toBe(200)
    expect(stats.body).toMatchObject({ since: null, by: 'rule' })
    expect(stats.body.groups.length).toBeGreaterThan(0)
    expect(stats.body.total.jobs).toBeGreaterThan(0)

    const weekly = await agw(['review', 'stats', '--bucket', 'week', '--by', 'tier', '--format', 'json'])
    expect(weekly.status).toBe(200)
    expect(weekly.body).toMatchObject({ by: 'tier', bucket: 'week', groups: [] })
    expect(weekly.body.weeks.length).toBeGreaterThan(0)

    const bad = await agw(['review', 'stats', '--since', 'not a date'])
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/since must be an ISO date or timestamp/)

    const relative = await agw(['review', 'stats', '--since', '7d'])
    expect(relative.status).toBe(200)
    expect(relative.body.since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
