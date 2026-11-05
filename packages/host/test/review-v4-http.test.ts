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
const late: ReviewService = {
  prepare: (i) => service.prepare(i),
  submit: (i) => service.submit(i),
  dispose: (i) => service.dispose(i),
  status: (i) => service.status(i),
  route: (i) => service.route(i),
  cancel: (i) => service.cancel(i),
  covered: (i) => service.covered(i),
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
})
