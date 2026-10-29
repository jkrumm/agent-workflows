import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, casesPath, type Exec, exec, writeCases } from '@agent-workflows/eval'
import type { Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { createCheckWorkflows } from '../src/workflows/check/index.ts'
import { createEvalWorkflows, sweepCaseTrees, wireEval } from '../src/workflows/eval/index.ts'
import { hostModules, suitesOf } from '../src/workflows/index.ts'
import { freshSchema, inspector, testRuntime, until } from '../../runtime/test/support/pg.ts'

const HOST_SUITES = suitesOf(await hostModules())

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

type Overrides = Partial<Pick<Runtime, 'runByKey' | 'scoreRun' | 'cancel' | 'wait'>>

/** A runtime with the eval workflows wired to it, through `overrides` where a test breaks or slows a call. */
function boot(
  host: FakeAgentHost,
  overrides: (rt: Runtime) => Overrides = () => ({}),
): { rt: Runtime; evalRun: ReturnType<typeof createEvalWorkflows>[0]['workflow'] } {
  const check = createCheckWorkflows()
  const evals = createEvalWorkflows(HOST_SUITES, { env, tmpRoot, exec: counting })
  const rt = testRuntime({ schema: db.schema, workflows: [...check, ...evals].map((e) => e.workflow), host })
  const view = {
    start: rt.start.bind(rt),
    wait: rt.wait.bind(rt),
    cancel: rt.cancel.bind(rt),
    getRun: rt.getRun.bind(rt),
    scoreRun: rt.scoreRun.bind(rt),
    scoredRuns: rt.scoredRuns.bind(rt),
    recentCost: rt.recentCost.bind(rt),
    runByKey: rt.runByKey.bind(rt),
    driftCandidates: rt.driftCandidates.bind(rt),
    ...overrides(rt),
  }
  wireEval({ runtime: view, workflows: [...check, ...evals], env })
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
      expect(readdirSync(tmpRoot)).toEqual([]) // the adopting process removed the kept tree
      // ...after the adopted run ended, unharmed: both case runs done, their checks passed.
      expect(after.map((r) => r.status)).toEqual(['done', 'done'])
      expect(out.cases).toMatchObject([
        { status: 'scored', pass: true },
        { status: 'scored', pass: true },
      ])
    } finally {
      await second.rt.close()
      for (const dir of readdirSync(tmpRoot)) rmSync(join(tmpRoot, dir), { recursive: true, force: true })
    }
  })

  test('cancelling an eval run cancels its case runs, starts no more cases and removes a clone only after its run ended', async () => {
    const held = heldHost()
    // A slow cancel: a tree removed before the case run ended would show up as a running r2 below.
    const { rt, evalRun } = boot(held.host, (real) => ({
      cancel: async (id: string) => {
        await Bun.sleep(1500) // longer than a case's wait poll (500 ms)
        return real.cancel(id)
      },
    }))
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
      await until(() => readdirSync(tmpRoot).length === 0, 'clones removed', 10_000)
      const runs = await caseRuns(runId)
      expect(runs.map((r) => [r.key.split(':').at(-1), r.status])).toEqual([
        ['r1', 'done'],
        ['r2', 'cancelled'],
      ])
    } finally {
      held.release()
      await rt.close()
    }
  })

  test('a failing lookup on the adopt path and a scorer error are per-case errors, out of the pass rate', async () => {
    const host = new FakeAgentHost(async () => ({
      output: { passed: true, steps: [{ name: 'test', passed: true }], summary: 'ok' },
    }))
    const { rt, evalRun } = boot(host, (real) => ({
      runByKey: async (workflow: string, key: string) => {
        if (key.endsWith(':r1')) throw new Error('journal blip')
        return real.runByKey(workflow, key)
      },
      scoreRun: async (id, options) => {
        if (options.caseId !== 'r2') return real.scoreRun(id, options)
        return { source: 'regression', scorer: 'x', caseId: 'r2', scores: {}, pass: null, error: 'scorer bug' }
      },
    }))
    await rt.open()
    try {
      const { runId } = await rt.start(evalRun, { workflow: 'check', yes: true }, { purpose: 'prod' })
      const end = await rt.wait(runId)
      expect(end.status).toBe('done')
      const out = end.output as {
        cases: { caseId: string; status: string; reason?: string }[]
        summary: { scored: number; errors: number; passRate: number | null }
      }
      expect(out.cases.map((c) => [c.caseId, c.status, c.reason])).toEqual([
        ['r1', 'error', 'journal blip'],
        ['r2', 'error', 'scorer: scorer bug'],
        ['r3', 'scored', undefined],
      ])
      expect(out.summary).toMatchObject({ scored: 1, errors: 2, passRate: 1 })
      expect(readdirSync(tmpRoot)).toEqual([])
    } finally {
      await rt.close()
    }
  })

  test('a failed wait keeps the tree, and the case run goes on unharmed', async () => {
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(300)
      return { output: { passed: true, steps: [{ name: 'test', passed: true }], summary: 'ok' } }
    })
    let caseRun: string | null = null
    const { rt, evalRun } = boot(host, (real) => ({
      wait: async (id, options) => {
        if (options?.pollMs === 500 && caseRun === null) {
          caseRun = id
          throw new Error('wait blip')
        }
        return real.wait(id, options)
      },
    }))
    await rt.open()
    try {
      const end = await rt.wait(
        (await rt.start(evalRun, { workflow: 'check', ids: 'r3', yes: true }, { purpose: 'prod' })).runId,
      )
      expect((end.output as { cases: { reason?: string }[] }).cases[0]?.reason).toBe('wait blip')
      expect(readdirSync(tmpRoot)).toHaveLength(1) // its run was live: the tree stays
      expect((await rt.wait(caseRun as unknown as string)).status).toBe('done')
      // The sweep removes it once its run ended (old enough), keeps a live one, a marker-less leftover goes.
      writeFileSync(join(tmpRoot, 'not-ours'), '')
      mkdirSync(join(tmpRoot, 'agw_eval_case_nomarker'))
      mkdirSync(join(tmpRoot, 'agw_eval_case_live'))
      writeFileSync(
        join(tmpRoot, 'agw_eval_case_live', '.agw-case.json'),
        JSON.stringify({ workflow: 'check', key: 'live' }),
      )
      const runtime = {
        runByKey: async (workflow: string, key: string) =>
          key === 'live'
            ? { runId: 'x', status: 'running' as const, error: null, final: null, fingerprint: null }
            : rt.runByKey(workflow, key),
      }
      expect(await sweepCaseTrees({ runtime, tmpRoot, olderThanMs: 3_600_000 })).toEqual([]) // all fresh
      // `now` a minute on: a directory made this instant can carry an mtime a hair past Date.now().
      const unmarked: string[] = []
      const removed = await sweepCaseTrees({
        runtime,
        tmpRoot,
        olderThanMs: 0,
        now: Date.now() + 60_000,
        onUnmarked: (dir) => unmarked.push(dir),
      })
      expect(removed).toHaveLength(1) // only the tree whose marked run ended
      expect(unmarked).toEqual([join(tmpRoot, 'agw_eval_case_nomarker')]) // reported, never deleted
      expect(readdirSync(tmpRoot).sort()).toEqual(['agw_eval_case_live', 'agw_eval_case_nomarker', 'not-ours'])
    } finally {
      await rt.close()
      for (const dir of readdirSync(tmpRoot)) rmSync(join(tmpRoot, dir), { recursive: true, force: true })
    }
  })

  test('on resume, a case whose recorded score is a scorer error is scored again', async () => {
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
    const scored = (await caseRuns(runId)).find((r) => r.scored_at)?.key as string
    await sql.pool.query(
      `update "${db.schema}".runs set score_error = 'scorer bug', score_error_kind = 'scorer',
         scores = jsonb_set(scores, '{final}', (scores->'final') - 'pass' || '{"pass":null,"error":"scorer bug","scores":{}}')
       where idempotency_key = $1`,
      [scored],
    )
    await first.rt.close()
    const second = boot(held.host)
    await second.rt.open()
    try {
      held.release()
      const out = (await second.rt.wait(runId)).output as { cases: { status: string }[] }
      expect(out.cases.map((c) => c.status)).toEqual(['scored', 'scored'])
      const { rows } = await sql.pool.query(`select score_error from "${db.schema}".runs where idempotency_key = $1`, [
        scored,
      ])
      expect(rows).toEqual([{ score_error: null }])
    } finally {
      await second.rt.close()
      for (const dir of readdirSync(tmpRoot)) rmSync(join(tmpRoot, dir), { recursive: true, force: true })
    }
  })

  test('a sweep never overlaps itself, and close waits for the running one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-evalsweep-'))
    const dir = join(root, 'agw_eval_case_old')
    mkdirSync(dir)
    writeFileSync(join(dir, '.agw-case.json'), JSON.stringify({ workflow: 'check', key: 'k' }))
    const old = new Date(Date.now() - 5 * 3_600_000)
    utimesSync(dir, old, old)
    let lookups = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = {
      runByKey: async () => {
        lookups++
        await gate
        return null
      },
      driftCandidates: async () => [],
    }
    const wiring = wireEval({
      runtime: runtime as never,
      workflows: createEvalWorkflows(HOST_SUITES, { env, tmpRoot: root }),
      env: { AGW_DRIFT_RATE: '0' },
      logger: { warn: () => {}, error: () => {} },
    })
    try {
      wiring.start()
      await until(() => lookups === 1, 'first sweep looking up')
      const second = wiring.sweep()
      await Bun.sleep(50)
      expect(lookups).toBe(1) // the second call joined the running sweep
      let closed = false
      const closing = wiring.close().then(() => {
        closed = true
      })
      await Bun.sleep(50)
      expect(closed).toBe(false) // close waits for the running sweep
      release()
      await Promise.all([second, closing])
      expect(readdirSync(root)).toEqual([]) // its run does not exist: removed
    } finally {
      release()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
