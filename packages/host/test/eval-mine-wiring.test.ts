import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gtPath } from '@agent-workflows/eval'
import { pgLabelStepCosts } from '../src/workflows/eval-mine/history.ts'
import type { HostRegistry } from '../src/workflows/index.ts'
import evalMine from '../src/workflows/eval-mine/module.ts'
import { gate, startTestHost, type TestHost } from './support.ts'

/** The module as the host builds it: `deps.costHistory` is the journal query on the read pool, as `boot.ts` wires it. */

const KEYS = ['AGW_EVAL_HOME', 'AGW_EVAL_DIR', 'AGW_EVAL_OWNER_EMAILS'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
let sandbox: string
let t: TestHost

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'agw-evalmine-wiring-'))
  // One repository with three intro/fix pairs, so mining plans three candidates to label.
  const repo = join(sandbox, 'home', 'SourceRoot', 'alpha')
  mkdirSync(repo, { recursive: true })
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const ran = Bun.spawnSync(['git', '-C', repo, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: sandbox,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...extra,
      },
    })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  }
  const commit = (files: Record<string, string>, message: string, date: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
    }
    const when = `${date}T10:00:00+0000`
    run(['add', '-A'])
    run(['commit', '--quiet', '-m', message], {
      GIT_AUTHOR_NAME: 'F',
      GIT_AUTHOR_EMAIL: 'me@example.com',
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: 'F',
      GIT_COMMITTER_EMAIL: 'me@example.com',
      GIT_COMMITTER_DATE: when,
    })
  }
  run(['init', '--quiet', '--initial-branch=main'])
  commit({ 'README.md': '# alpha\n' }, 'chore: init', '2026-01-01')
  for (const [name, bad, good, intro, fix] of [
    ['add', 'a - b', 'a + b', '2026-09-01', '2026-09-20'],
    ['mul', 'a + b', 'a * b', '2026-09-02', '2026-09-21'],
    ['neg', 'a', '-a', '2026-09-03', '2026-09-22'],
  ] as const) {
    const body = (expr: string) => `export function ${name}(a: number, b: number) {\n  return ${expr}\n}\n`
    commit({ [`src/${name}.ts`]: body(bad) }, `feat: ${name}\n\nBody of ${name}.`, intro)
    commit({ [`src/${name}.ts`]: body(good) }, `fix: ${name} is wrong`, fix)
  }
  process.env.AGW_EVAL_HOME = join(sandbox, 'home')
  process.env.AGW_EVAL_DIR = join(sandbox, 'eval')
  process.env.AGW_EVAL_OWNER_EMAILS = 'me@example.com'
  const extra = evalMine.create(
    {
      registry: {} as HostRegistry,
      toolGate: gate() as never,
      costHistory: { labelStepCosts: (options) => pgLabelStepCosts(t.pool, t.schema)(options) },
    },
    { suites: new Map(), peers: [] },
  )
  t = await startTestHost({ prefix: 'evalminewire', extra })
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
/** An `eval.mine` run with a `label` step of the given cost, as the journal holds it after a labelling run. */
async function seed(options: { workflow?: string; stepId?: string; cost: number | null; child?: boolean }) {
  const id = `seed-${n++}`
  const { workflow = 'eval.mine', stepId = 'label', cost, child = false } = options
  await t.pool.query(
    `insert into ${t.schema}.runs (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, finished_at)
     values ($1, $2, $3, 'done', 'test', '{}', 'h', $4, 'test', now())`,
    [id, workflow, child ? 'seed-root' : id, 1000 + n],
  )
  await t.pool.query(
    `insert into ${t.schema}.steps (run_id, step_id, kind, status, cost, finished_at) values ($1, $2, 'effect', 'done', $3, now())`,
    [id, stepId, cost],
  )
  return id
}

/** `count` records of `runId` in the temp `labels.jsonl`; the seats are errors, the estimate reads only the run ids. */
function writeLabels(records: { runId: string; count: number }[]) {
  const path = gtPath('labels.jsonl', process.env)
  mkdirSync(dirname(path), { recursive: true })
  let i = 0
  const lines = records.flatMap(({ runId, count }) =>
    Array.from({ length: count }, () =>
      JSON.stringify({
        candidateId: `c${i++}`,
        labelerVersion: 'old-version',
        at: '2026-10-01T00:00:00.000Z',
        a: { error: 'x' },
        b: { error: 'x' },
        runId,
      }),
    ),
  )
  writeFileSync(path, `${lines.join('\n')}\n`)
}

async function plan() {
  const { body } = await t.json(
    await t.call('/workflows/eval/mine', {
      method: 'POST',
      body: { suite: 'review', label: 3 },
      headers: { prefer: 'wait=60' },
    }),
  )
  if (body.status !== 'done') throw new Error(JSON.stringify(body))
  return body.output.labelPlan
}

describe('eval.mine: the host wiring of the label estimate', () => {
  test('without a labelling run in the journal the estimate stays unknown', async () => {
    const out = await plan()
    expect(out.candidates).toBe(3)
    expect(out.estimate).toEqual({ historyRuns: 0, meanCostUsd: null, totalUsd: null })
  })

  test('the estimate is the label step cost of an eval.mine run per label it wrote', async () => {
    const runId = await seed({ cost: 5.14 })
    // Each of these wrote labels too, and none counts: not priced, not eval.mine, not the label step, a child run.
    const decoys = [
      await seed({ cost: null }),
      await seed({ workflow: 'other', cost: 9 }),
      await seed({ stepId: 'mine', cost: 9 }),
      await seed({ cost: 9, child: true }),
    ]
    writeLabels([{ runId, count: 4 }, ...decoys.map((id) => ({ runId: id, count: 2 }))])
    const { estimate } = await plan()
    expect(estimate.historyRuns).toBe(1)
    expect(estimate.meanCostUsd).toBeCloseTo(5.14 / 4, 10)
    // 3 candidates this run: the mean already covers both labeller calls per candidate.
    expect(estimate.totalUsd).toBeCloseTo((5.14 / 4) * 3, 10)
  })
})
