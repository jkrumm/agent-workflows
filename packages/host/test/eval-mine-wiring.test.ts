import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostRegistry } from '../src/workflows/index.ts'
import evalMine from '../src/workflows/eval-mine/module.ts'
import { gate, startTestHost, type TestHost } from './support.ts'

/** The module as the host builds it: `deps.costHistory` reads the runtime lazily, as `boot.ts` does. */

const KEYS = ['AGW_EVAL_HOME', 'AGW_EVAL_DIR', 'AGW_EVAL_OWNER_EMAILS'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
let sandbox: string
let t: TestHost
let runtime: TestHost['runtime'] | undefined

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'agw-evalmine-wiring-'))
  // One repository so mining has something to read; it holds no fix pairs, so no candidate is planned (the total is 0).
  const repo = join(sandbox, 'home', 'SourceRoot', 'alpha')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# alpha\n')
  const identity = {
    GIT_AUTHOR_NAME: 'F',
    GIT_AUTHOR_EMAIL: 'me@example.com',
    GIT_COMMITTER_NAME: 'F',
    GIT_COMMITTER_EMAIL: 'me@example.com',
  }
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'chore: init'],
  ]) {
    const ran = Bun.spawnSync(['git', '-C', repo, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: sandbox,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...identity,
      },
    })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  }
  process.env.AGW_EVAL_HOME = join(sandbox, 'home')
  process.env.AGW_EVAL_DIR = join(sandbox, 'eval')
  process.env.AGW_EVAL_OWNER_EMAILS = 'me@example.com'
  const extra = evalMine.create(
    {
      registry: {} as HostRegistry,
      toolGate: gate() as never,
      costHistory: {
        recentCost: (workflow, limit) => {
          if (!runtime) throw new Error('the host runtime is not built yet')
          return runtime.recentCost(workflow, limit)
        },
      },
    },
    { suites: new Map(), peers: [] },
  )
  t = await startTestHost({ prefix: 'evalminewire', extra })
  runtime = t.runtime
})
afterAll(async () => {
  await t.close()
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(sandbox, { recursive: true, force: true })
})

let n = 0
async function seed(workflow: string, status: string, cost: number | null) {
  const id = `seed-${n++}`
  await t.pool.query(
    `insert into ${t.schema}.runs (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, cost, finished_at)
     values ($1, $2, $1, $3, 'test', '{}', 'h', $4, 'test', $5, now())`,
    [id, workflow, status, 1000 + n, cost],
  )
}

async function plan() {
  const { body } = await t.json(
    await t.call('/workflows/eval/mine', {
      method: 'POST',
      body: { suite: 'review', label: 2 },
      headers: { prefer: 'wait=60' },
    }),
  )
  if (body.status !== 'done') throw new Error(JSON.stringify(body))
  return body.output.labelPlan
}

describe('eval.mine: the host wiring of the cost history', () => {
  test('without done cap.eval.label runs the estimate stays unknown', async () => {
    expect((await plan()).estimate).toEqual({ historyRuns: 0, meanCostUsd: null, totalUsd: null })
  })

  test('the estimate reads the mean cost of done cap.eval.label runs in the journal', async () => {
    await seed('cap.eval.label', 'done', 0.1)
    await seed('cap.eval.label', 'done', 0.3)
    await seed('cap.eval.label', 'failed', 9) // not done
    await seed('cap.other', 'done', 9) // another workflow
    const { estimate } = await plan()
    expect(estimate.historyRuns).toBe(2)
    expect(estimate.meanCostUsd).toBeCloseTo(0.2, 10)
    expect(typeof estimate.totalUsd).toBe('number')
  })
})
