import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GtCase } from '@agent-workflows/eval'
import { freshSchema, PG_URL, testRuntime } from '@agent-workflows/testing/pg'
import { Pool } from 'pg'
import { createReviewService } from '../src/review/index.ts'
import { gitRunner } from '../src/review/route.ts'
import { gitClones } from '../src/workflows/eval-recall/clones.ts'
import { commit, fakeReviewer, git, lines, makeRepo } from './support/review-repo.ts'

// The point of the isolated clone: a case's review sees neither the owner's fix commit nor the ledger's earlier findings.
const db = freshSchema('rcl')
const pool = new Pool({ connectionString: PG_URL, max: 4 })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'agw-recall-iso-')))
let stateDir: string
let factoryBin: string

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
  stateDir = join(sandbox, 'state')
  mkdirSync(stateDir)
  factoryBin = join(sandbox, 'factory')
  writeFileSync(factoryBin, `#!/bin/sh\necho '{"status":"queued"}'\n`)
  chmodSync(factoryBin, 0o755)
})
afterAll(async () => {
  await pool.end()
  await db.drop()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('the isolated clone of a recall case', () => {
  test('prior.json is empty and history.txt stops at the parent, while the live checkout carries the fix and the ledger', async () => {
    // The owner's checkout: ~/SourceRoot/demo with an origin whose refs hold the fix.
    const home = join(sandbox, 'home')
    mkdirSync(join(home, 'SourceRoot'), { recursive: true })
    const live = makeRepo({ 'src/a.ts': lines(3) })
    commit(live, { 'src/a.ts': lines(4) }, 'feat: the buggy change')
    const sha = git(live, 'rev-parse', 'HEAD')
    const parent = git(live, 'rev-parse', 'HEAD~1')
    const fix = commit(live, { 'src/a.ts': lines(5) }, 'fix: the bug')
    git(live, 'remote', 'add', 'origin', 'https://example.com/owner/demo.git')
    git(live, 'update-ref', 'refs/remotes/origin/master', fix)
    const owner = join(home, 'SourceRoot', 'demo')
    renameSync(live, owner)

    const service = createReviewService({
      pool,
      schema: db.schema,
      stateDir,
      git: gitRunner,
      env: { ...process.env, AGW_FACTORY_BIN: factoryBin },
    })
    // A finding of the live repo on the same path, in the ledger.
    const earlier = await service.prepare({ cwd: owner, scope: `${parent}..${sha}`, thread: 'earlier' })
    await service.submit({
      jobId: earlier.jobId as string,
      attempt: 1,
      reply: fakeReviewer(earlier.jobDir as string, [
        { tag: 'important', file: 'src/a.ts', message: 'Earlier finding.' },
      ]),
    })

    const clones = gitClones({ env: { AGW_EVAL_HOME: home, AGW_EVAL_CLONES_DIR: join(sandbox, 'clones') } })
    const reference = GtCase.parse({
      id: 'c1',
      kind: 'control',
      split: 'dev',
      repo: 'SourceRoot/demo',
      sha,
      parent,
      subject: 'feat: the buggy change',
      minerVersion: 'm1',
    })
    const made = await clones.create(reference)
    if (!made.ok) throw new Error(made.reason)

    // No later commit, ref or remote is reachable from the clone.
    expect(git(made.dir, 'for-each-ref')).toBe('')
    expect(git(made.dir, 'remote')).toBe('')
    expect(existsSync(join(made.dir, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    expect(Bun.spawnSync(['git', 'cat-file', '-e', fix], { cwd: made.dir }).exitCode).not.toBe(0)

    const asked = await service.request({
      cwd: made.dir,
      scope: `${parent}..${sha}`,
      context: reference.subject,
      min: 'light',
    })
    expect(asked.status).toBe('requested')
    const jobDir = (await service.status({ jobId: asked.jobId })).job?.jobDir as string
    expect(JSON.parse(readFileSync(join(jobDir, 'prior.json'), 'utf8'))).toEqual([])
    const history = readFileSync(join(jobDir, 'history.txt'), 'utf8')
    expect(history).not.toContain('the bug')
    expect(history).not.toContain(fix.slice(0, 7))

    // Control: the same range prepared in the live checkout carries the ledger's finding.
    const leaky = await service.prepare({ cwd: owner, scope: `${parent}..${sha}`, thread: 'other' })
    expect(JSON.parse(readFileSync(join(leaky.jobDir as string, 'prior.json'), 'utf8'))).toHaveLength(1)

    clones.remove(made.dir)
    expect(existsSync(made.dir)).toBe(false)
  })
})
