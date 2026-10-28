import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, casesPath, type Exec, exec, writeCases } from '@agent-workflows/eval'
import type { Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createCheckWorkflows } from '../src/workflows/check/index.ts'
import { createEvalWorkflows, wireEval } from '../src/workflows/eval/index.ts'
import { freshSchema, inspector, testRuntime, until } from '../../runtime/test/support/pg.ts'

/** A resumed or cancelled `eval.run`: what it adopts, what it starts, what it leaves behind. */
const db = freshSchema('evalres')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evalres-'))
const home = join(root, 'home')
const tmpRoot = join(root, 'tmp')
const env = { AGW_EVAL_DIR: join(root, 'eval'), AGW_EVAL_HOME: home, AGW_DRIFT_RATE: '0' }

let clones = 0
const counting: Exec = (cmd, args, options) => {
  if (cmd === 'git' && args[0] === 'clone') clones++
  return exec(cmd, args, options)
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed`)
  return out.trim()
}

const ids = ['r1', 'r2', 'r3']

beforeAll(async () => {
  const repo = join(home, 'SourceRoot', 'demo')
  mkdirSync(repo, { recursive: true })
  mkdirSync(tmpRoot)
  await git(repo, 'init', '--quiet')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init')
  const baseSha = await git(repo, 'rev-parse', 'HEAD')
  const legacy = { passed: true, steps: [{ name: 'test', passed: true }], costUsd: null, costExact: true, wallMs: null }
  writeCases(
    casesPath('check', env),
    CheckCase,
    ids.map((id) => ({
      id,
      source: 'synthetic',
      createdAt: '2026-10-20T10:00:00.000Z',
      repo: 'SourceRoot/demo',
      input: { commands: ['bun test'] },
      baseSha,
      baseInferred: false,
      legacy,
    })),
  )
})

afterAll(async () => {
  await sql.close()
  await db.drop()
  rmSync(root, { recursive: true, force: true })
})

/** The first agent session answers at once; every later one waits for `release()` (or its abort). */
function heldHost() {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let sessions = 0
  const host = new FakeAgentHost(async (s) => {
    if (++sessions > 1)
      await Promise.race([released, new Promise((_, reject) => s.signal.addEventListener('abort', reject))])
    return { output: { passed: true, steps: [{ name: 'test', passed: true }], summary: 'ok' } }
  })
  return { host, release: () => release() }
}

function boot(host: FakeAgentHost): { rt: Runtime; evalRun: ReturnType<typeof createEvalWorkflows>[0]['workflow'] } {
  const check = createCheckWorkflows()
  const evals = createEvalWorkflows({ env, tmpRoot, exec: counting })
  const rt = testRuntime({ schema: db.schema, workflows: [...check, ...evals].map((e) => e.workflow), host })
  wireEval({ runtime: rt, workflows: [...check, ...evals], env })
  return { rt, evalRun: (evals[0] as (typeof evals)[0]).workflow }
}

const caseRuns = async (evalRunId: string) =>
  (
    await sql.pool.query(
      `select idempotency_key as key, status, scored_at from "${db.schema}".runs where idempotency_key like $1 order by idempotency_key`,
      [`eval:${evalRunId}:%`],
    )
  ).rows as { key: string; status: string; scored_at: Date | null }[]

describe('eval.run resume and cancel', () => {
  test('a resumed eval run adopts its case runs: no new clone, no second score of a finished case', async () => {
    const held = heldHost()
    const first = boot(held.host)
    await first.rt.open()
    const { runId } = await first.rt.start(
      first.evalRun,
      { workflow: 'check', ids: 'r1,r2', yes: true, concurrency: 2 },
      { purpose: 'prod' },
    )
    await until(
      async () => {
        const runs = await caseRuns(runId)
        return runs.length === 2 && runs.some((r) => r.scored_at) && runs.some((r) => r.status === 'running')
      },
      'one case scored, one running',
      15_000,
    )
    const scoredBefore = (await caseRuns(runId)).find((r) => r.scored_at)?.scored_at
    await first.rt.close()
    expect(clones).toBe(2)
    expect(readdirSync(tmpRoot)).toHaveLength(1) // the running case's clone survives the shutdown

    const second = boot(held.host)
    await second.rt.open()
    try {
      held.release()
      const end = await second.rt.wait(runId)
      expect(end.status).toBe('done')
      expect(clones).toBe(2) // nothing materialized again
      expect(held.host.count('open')).toBe(2)
      const out = end.output as { cases: { status: string }[] }
      expect(out.cases.map((c) => c.status)).toEqual(['scored', 'scored'])
      const after = await caseRuns(runId)
      expect(after.find((r) => r.scored_at?.getTime() === scoredBefore?.getTime())).toBeDefined()
    } finally {
      await second.rt.close()
      for (const dir of readdirSync(tmpRoot)) rmSync(join(tmpRoot, dir), { recursive: true, force: true })
    }
  })

  test('cancelling an eval run cancels its case runs, starts no more cases and removes the clones', async () => {
    const held = heldHost()
    const { rt, evalRun } = boot(held.host)
    await rt.open()
    try {
      // The first session answers: r1 finishes; r2 hangs; r3 must never start.
      const { runId } = await rt.start(evalRun, { workflow: 'check', yes: true, concurrency: 1 }, { purpose: 'prod' })
      await until(
        async () => (await caseRuns(runId)).some((r) => r.key.endsWith(':r2') && r.status === 'running'),
        'r2 running',
        15_000,
      )
      await rt.cancel(runId)
      expect((await rt.wait(runId)).status).toBe('cancelled')
      await until(async () => (await caseRuns(runId)).every((r) => r.status !== 'running'), 'case runs ended')
      const runs = await caseRuns(runId)
      expect(runs.map((r) => [r.key.split(':').at(-1), r.status])).toEqual([
        ['r1', 'done'],
        ['r2', 'cancelled'],
      ])
      await until(() => readdirSync(tmpRoot).length === 0, 'clones removed')
    } finally {
      held.release()
      await rt.close()
    }
  })
})
