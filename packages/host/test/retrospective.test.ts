import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Json } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { pgLearningsStore, withLearnedFacts } from '../src/learnings/index.ts'
import { renderSample, SUBMIT_RESULT_RETRY } from '../src/workflows/retrospective/prompt.ts'
import type { SignalPort } from '../src/workflows/retrospective/signals.ts'
import { TrackedPaths } from '../src/workflows/retrospective/tracked.ts'
import { createRetrospective, RETRO_WORKFLOW_ID } from '../src/workflows/retrospective/index.ts'
import { pgJournalReader } from '../src/workflows/retrospective/sample.ts'
import {
  isoWeek,
  MAX_WEEKLY_RETRIES,
  nextKey,
  retroKey,
  tickRetrospectives,
} from '../src/workflows/retrospective/schedule.ts'
import { freshSchema, inspector, testRuntime } from '@agent-workflows/testing/pg'

const db = freshSchema('retro')
const sql = inspector(db.schema)
const journal = pgJournalReader(sql.pool, db.schema)
const learnings = pgLearningsStore(sql.pool, db.schema)

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await sql.close()
  await db.drop()
})

const NOW = new Date('2026-10-28T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)
let seq = 0

type Seed = {
  workflow: string
  status?: string
  purpose?: string
  daysAgo?: number
  parent?: string
  input?: unknown
  error?: string
  steps?: { id: string; kind?: string; output?: unknown; error?: string }[]
}

/** A finished run straight into the journal; ids are fixed-width so the evidence filter accepts them. */
async function seed(s: Seed): Promise<string> {
  const id = `run-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`
  const finished = daysAgo(s.daysAgo ?? 1)
  await sql.pool.query(
    `insert into "${db.schema}".runs (id, workflow, parent_id, root_id, status, purpose, input, input_hash, lock_key,
       version_started, finished_at, error, error_kind, wall_ms, cost, tool_calls, fingerprint, friction)
     values ($1,$2,$3,$4,$5,$6,$7,'h',$8,'v1',$9,$10,$11,1500,0.01,3,'fp0123456789abcdef',$12)`,
    [
      id,
      s.workflow,
      s.parent ?? null,
      s.parent ?? id,
      s.status ?? 'done',
      s.purpose ?? 'prod',
      JSON.stringify(s.input ?? { cwd: '/Users/jane/work/acme-corp/app' }),
      seq,
      finished,
      s.error ?? null,
      s.error ? 'step_failed' : null,
      null,
    ],
  )
  for (const step of s.steps ?? []) {
    await sql.pool.query(
      `insert into "${db.schema}".steps (run_id, step_id, kind, status, output, error, error_kind, model, tool_calls)
       values ($1,$2,$3,$4,$5,$6,$7,'haiku',2)`,
      [
        id,
        step.id,
        step.kind ?? 'agent',
        step.error ? 'failed' : 'done',
        step.output === undefined ? null : JSON.stringify(step.output),
        step.error ?? null,
        step.error ? 'error' : null,
      ],
    )
  }
  return id
}

const since = (days: number) => daysAgo(days)

describe('sampling', () => {
  const wf = 'sample.wf'
  let ids: Record<string, string>

  beforeAll(async () => {
    ids = {
      recent: await seed({ workflow: wf, daysAgo: 1 }),
      older: await seed({ workflow: wf, daysAgo: 6 }),
      outside: await seed({ workflow: wf, daysAgo: 9 }),
      eval: await seed({ workflow: wf, purpose: 'eval', daysAgo: 1 }),
      running: await seed({ workflow: wf, status: 'running', daysAgo: 1 }),
      cancelled: await seed({ workflow: wf, status: 'cancelled', daysAgo: 1 }),
      failed: await seed({ workflow: wf, status: 'failed', error: 'boom in /Users/jane/app', daysAgo: 3 }),
      other: await seed({ workflow: 'sample.other', daysAgo: 1 }),
    }
    ids.child = await seed({ workflow: wf, parent: ids.recent, daysAgo: 1 })
  })

  test('finished top-level runs of the workflow inside the window; eval, running, cancelled and children excluded', async () => {
    const runs = await journal.sample({ workflow: wf, since: since(7), limit: 50 })
    expect(runs.map((r) => r.runId).sort()).toEqual([ids.recent, ids.older, ids.failed].sort() as string[])
    expect(await journal.countFinished({ workflow: wf, since: since(7) })).toBe(3)
    expect((await journal.sample({ workflow: wf, since: since(10), limit: 50 })).map((r) => r.runId)).toContain(
      ids.outside as string,
    )
    expect(await journal.countFinished({ workflow: 'sample.none', since: since(7) })).toBe(0)
  })

  test('failed runs come first and the limit cuts the rest; the same query reads the same runs', async () => {
    const two = await journal.sample({ workflow: wf, since: since(7), limit: 2 })
    expect(two[0]?.runId).toBe(ids.failed)
    expect(two).toHaveLength(2)
    expect(await journal.sample({ workflow: wf, since: since(7), limit: 2 })).toEqual(two)
  })

  test('the record carries outcome, cost and steps; a null friction is tolerated; the run input is never read', async () => {
    const [failed] = await journal.sample({ workflow: wf, since: since(7), limit: 1 })
    expect(failed).toMatchObject({
      runId: ids.failed,
      status: 'failed',
      errorKind: 'step_failed',
      friction: null,
      wallMs: 1500,
      toolCalls: 3,
    })
    expect(JSON.stringify(failed)).not.toContain('acme-corp')
    expect(Object.keys(failed ?? {})).not.toContain('input')
  })

  test('a step whose tools went through the host gate lists them by name: calls, failures, repeats of the same arguments', async () => {
    const id = await seed({ workflow: 'sample.tools', steps: [{ id: 'research' }, { id: 'plain' }] })
    const call = (tool: string, digest: string, ok: boolean) =>
      sql.pool.query(
        `insert into "${db.schema}".research_tool_calls (run_id, step_id, tool, args_digest, ok) values ($1, 'research', $2, $3, $4)`,
        [id, tool, digest, ok],
      )
    await call('fetch', 'a', true)
    await call('fetch', 'a', false)
    await call('fetch', 'b', true)
    await call('search', 'c', true)
    const [run] = await journal.sample({ workflow: 'sample.tools', since: since(7), limit: 1 })
    const step = (name: string) => run?.steps.find((s) => s.stepId === name)
    expect(step('research')?.tools).toEqual([
      { tool: 'fetch', calls: 3, failed: 1, repeats: 1 },
      { tool: 'search', calls: 1, failed: 0, repeats: 0 },
    ])
    expect(step('plain')?.tools).toEqual([])
    expect(renderSample(run ? [run] : [])).toContain('tools 2 (fetch ×3 (1 failed, 1 repeated), search ×1)')
  })

  test('step outputs are cut to a preview', async () => {
    const big = await seed({ workflow: 'sample.big', steps: [{ id: 'a', output: { text: 'x'.repeat(5000) } }] })
    const [run] = await journal.sample({ workflow: 'sample.big', since: since(7), limit: 1 })
    expect(run?.runId).toBe(big)
    expect(run?.steps[0]?.output?.length).toBeLessThanOrEqual(1200)
  })
})

/** A signal port that records what is filed; `failing` makes it refuse like a factory that is down. */
function fakeSignals(options: { failing?: boolean } = {}) {
  const filed: { title: string; text: string }[] = []
  const signals: SignalPort = {
    async file(signal) {
      if (options.failing) throw new Error('factory signal file failed (exit 1: unreachable)')
      filed.push(signal)
    },
  }
  return { signals, filed }
}

const TRACKED = new TrackedPaths([
  'agents/agent-one/AGENTS.md',
  'agents/agent-two/skills/x/SKILL.md',
  'packages/cli/src/run.ts',
])

describe('the workflow', () => {
  const agents = ['agent-one', 'agent-two']
  const wf = 'wf.agents'
  let runIds: string[]
  const rid = (i: number) => runIds[i] as string

  beforeAll(async () => {
    runIds = [
      await seed({
        workflow: wf,
        status: 'failed',
        error: 'schema re-ask in /Users/jane/app/src',
        input: { cwd: 'PRIVATE-INPUT-MARKER' },
        steps: [{ id: 'agent', output: { note: 'a' }, error: 'invalid_output' }],
      }),
      await seed({ workflow: wf, steps: [{ id: 'agent', output: { note: 'b' } }] }),
      await seed({ workflow: wf, steps: [{ id: 'agent', output: { note: 'c' } }] }),
    ]
  })

  function setup(options: { script?: ConstructorParameters<typeof FakeAgentHost>[0]; signals?: SignalPort } = {}) {
    const host = new FakeAgentHost(options.script)
    const entry = createRetrospective({
      journal,
      learnings,
      signals: options.signals,
      tracked: async () => TRACKED,
      now: () => NOW,
      agentsOf: (id) => (id === wf ? agents : undefined),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
    return { host, entry, rt }
  }

  const answer =
    (over: { proposals?: Json[]; learnings?: Json[] } = {}) =>
    async () => ({
      output: {
        proposals: over.proposals ?? [
          {
            kind: 'agents-md',
            target: 'agents/agent-one/AGENTS.md',
            title: 'Tell agent-one to confirm the schema first',
            change: 'Two runs re-asked on the output schema; state the schema before the task.',
            evidence: [rid(0), rid(1)],
            confidence: 'medium',
          },
        ],
        learnings: over.learnings ?? [
          { agent: 'agent-one', fact: 'Schema re-asks follow a missing summary field', evidence: [rid(0)] },
        ],
      },
    })

  test('one agent step over the sample → typed proposals and proposed (never active) learnings', async () => {
    const { host, entry, rt } = setup({ script: answer() })
    await rt.open()
    try {
      const { runId } = await rt.start(entry.workflow, { workflow: wf }, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      expect(result.output).toMatchObject({
        workflow: wf,
        windowDays: 7,
        sampled: 3,
        proposals: [
          {
            kind: 'agents-md',
            target: 'agents/agent-one/AGENTS.md',
            confidence: 'medium',
            evidence: [rid(0), rid(1)],
          },
        ],
        learnings: [{ agent: 'agent-one', fact: 'Schema re-asks follow a missing summary field', evidence: [rid(0)] }],
        signals: [],
        tidy: { merged: 0, activated: [], retired: [] },
        dropped: [],
      })
      expect(host.count('open')).toBe(1)

      const stored = await learnings.list({ agent: 'agent-one' })
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ status: 'proposed', source: runId, evidence: [rid(0)] })
      expect(await learnings.activeFor('agent-one')).toEqual([])

      // The agent saw the runs: ids, failure kinds, scrubbed paths; never a run input.
      const prompt = [...host.sessions.values()][0]?.spec.prompt ?? ''
      expect(prompt).toContain(rid(0))
      expect(prompt).toContain('agent-one, agent-two')
      expect(prompt).toContain('step_failed')
      expect(prompt).not.toContain('PRIVATE-INPUT-MARKER')
      expect(prompt).not.toContain('/Users/jane')
      expect(prompt).toContain('<path>')
    } finally {
      await rt.close()
    }
  })

  test('answers the sample cannot back are dropped with a reason, not repaired', async () => {
    const { entry, rt } = setup({
      script: answer({
        proposals: [
          {
            kind: 'cli',
            target: 'agw review',
            title: 'Cite a run that was never sampled',
            change: 'x',
            evidence: ['run-nope'],
            confidence: 'low',
          },
          {
            kind: 'cli',
            target: '/Users/jane/app/AGENTS.md',
            title: 'An absolute target path',
            change: 'x',
            evidence: [rid(1)],
            confidence: 'low',
          },
        ],
        learnings: [
          { agent: 'not-an-agent', fact: 'unknown agent', evidence: [rid(1)] },
          { agent: 'agent-two', fact: 'no evidence in the sample', evidence: ['run-nope'] },
        ],
      }),
    })
    await rt.open()
    try {
      const { runId } = await rt.start(entry.workflow, { workflow: wf }, { purpose: 'build' })
      const out = (await rt.wait(runId)).output as { proposals: unknown[]; learnings: unknown[]; dropped: string[] }
      expect(out.proposals).toEqual([])
      expect(out.learnings).toEqual([])
      expect(out.dropped).toHaveLength(4)
      expect(out.dropped.join('\n')).toContain('no evidence from the sample')
      expect(out.dropped.join('\n')).toContain('not a repo-relative path')
      expect(out.dropped.join('\n')).toContain('does not run this agent')
    } finally {
      await rt.close()
    }
  })

  test('an invalid answer is re-asked once; two invalid answers fail the run', async () => {
    let calls = 0
    const retry = setup({
      script: async () => ({ output: (++calls === 1 ? { nope: 1 } : { proposals: [], learnings: [] }) as Json }),
    })
    await retry.rt.open()
    try {
      const { runId } = await retry.rt.start(retry.entry.workflow, { workflow: wf }, { purpose: 'build' })
      expect((await retry.rt.wait(runId)).status).toBe('done')
      expect(calls).toBe(2)
    } finally {
      await retry.rt.close()
    }
    const bad = setup({ script: async () => ({ output: { nope: 1 } }) })
    await bad.rt.open()
    try {
      const { runId } = await bad.rt.start(bad.entry.workflow, { workflow: wf }, { purpose: 'build' })
      expect((await bad.rt.wait(runId)).status).toBe('failed')
    } finally {
      await bad.rt.close()
    }
  })

  test('no runs in the window: no agent session is opened', async () => {
    const quiet = 'wf.quiet'
    const host = new FakeAgentHost()
    const entry = createRetrospective({
      journal,
      learnings,
      now: () => NOW,
      agentsOf: (id) => (id === quiet ? agents : undefined),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
    await rt.open()
    try {
      const { runId } = await rt.start(entry.workflow, { workflow: quiet }, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toMatchObject({ sampled: 0, proposals: [], learnings: [], signals: [] })
      expect(host.count('open')).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('a workflow without agents, or fileSignals with no signal port, fails before any step', async () => {
    const { entry, rt } = setup({ script: answer() })
    await rt.open()
    try {
      const unknown = await rt.start(entry.workflow, { workflow: 'smoke.ping' }, { purpose: 'build' })
      expect(await rt.wait(unknown.runId)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
      const noPort = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
      expect(await rt.wait(noPort.runId)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
    } finally {
      await rt.close()
    }
  })

  describe('signals', () => {
    const proposal = (target: string, title: string, evidence: string[], confidence = 'medium') => ({
      kind: 'cli',
      target,
      title,
      change: `Change for ${title}`,
      evidence,
      confidence,
    })

    test('off by default: the port is never called', async () => {
      const { signals, filed } = fakeSignals()
      const { entry, rt } = setup({ script: answer(), signals })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf }, { purpose: 'build' })
        const out = (await rt.wait(runId)).output as { signals: unknown[] }
        expect(out.signals).toEqual([])
        expect(filed).toEqual([])
      } finally {
        await rt.close()
      }
    })

    test('a repeated failure yields one signal that names the run ids and the structured fields only', async () => {
      const { signals, filed } = fakeSignals()
      const { entry, rt } = setup({ script: answer(), signals })
      await rt.open()
      try {
        const first = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
        const out = (await rt.wait(first.runId)).output as {
          signals: { status: string; hash: string; title: string }[]
        }
        expect(out.signals).toHaveLength(1)
        expect(out.signals[0]).toMatchObject({ status: 'filed' })
        expect(filed).toHaveLength(1)
        const { title, text } = filed[0] ?? { title: '', text: '' }
        expect(title).toBe(
          `retro(${wf}): agents-md change for agents/agent-one/AGENTS.md [${out.signals[0]?.hash.slice(0, 8)}]`,
        )
        expect(text).toContain(`agw-retro:${out.signals[0]?.hash}`)
        expect(text).toContain('`agents/agent-one/AGENTS.md`')
        expect(text).toContain(`\`${rid(0)}\`, \`${rid(1)}\``)
        expect(text).toContain('2 of 3 sampled runs')
        expect(text).toContain(`agw run status ${first.runId}`)
        // the model's own words (title and change) stay in the private run output
        expect(text).not.toContain('Two runs re-asked')
        expect(title).not.toContain('confirm the schema')
        for (const leak of ['PRIVATE-INPUT-MARKER', '/Users', 'acme-corp', 'cwd']) expect(text).not.toContain(leak)
      } finally {
        await rt.close()
      }
    })

    test('an eval fixture files nothing and stores nothing, even with fileSignals', async () => {
      const { signals, filed } = fakeSignals()
      const { entry, rt } = setup({ script: answer(), signals })
      await rt.open()
      try {
        const fixture = {
          runs: [0, 1].map((i) => ({
            runId: `eval-run-${i}-aaaa`,
            status: 'failed' as const,
            steps: [{ stepId: 'agent', kind: 'agent', status: 'failed' }],
          })),
        }
        const { runId } = await rt.start(
          entry.workflow,
          { workflow: wf, fileSignals: true, fixture },
          { purpose: 'eval' },
        )
        const result = await rt.wait(runId)
        expect(result.status).toBe('done')
        expect((result.output as { signals: unknown[] }).signals).toEqual([])
        expect(filed).toEqual([])
      } finally {
        await rt.close()
      }
    })

    test('a target that is not tracked is refused, not filed; the proposal stays in the output; the others are filed', async () => {
      const { signals, filed } = fakeSignals()
      const { entry, rt } = setup({
        signals,
        script: answer({
          proposals: [
            {
              kind: 'skill',
              target: 'packages/acme-billing/src/ledger.ts',
              title: 'Invented path under a real root',
              change: 'In ghp_abcdefghijklmnopqrstuvwxyz0123456789 the skill fails on build-box.example.de.',
              evidence: [rid(1)],
              confidence: 'low',
            },
            {
              kind: 'cli',
              target: 'packages/cli/src/run.ts',
              title: 'Print the failing step name first',
              change: 'Agents grep the output for the step name.',
              evidence: [rid(1), rid(2)],
              confidence: 'high',
            },
            {
              kind: 'cli',
              target: 'packages/cli/src/run.ts',
              title: 'Print the failing step name first, again',
              change: 'agents  GREP the output for the step name.',
              evidence: [rid(2)],
              confidence: 'low',
            },
          ],
          learnings: [],
        }),
      })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
        const out = (await rt.wait(runId)).output as {
          proposals: unknown[]
          signals: { status: string; reason?: string }[]
        }
        expect(out.proposals).toHaveLength(3) // reported, even when not filed
        // ranked: the two-run proposal first, then the single-run ones
        expect(out.signals.map((i) => i.status).sort()).toEqual(['duplicate', 'filed', 'refused'].sort())
        expect(out.signals.find((i) => i.status === 'refused')?.reason).toContain('not a tracked path')
        expect(filed).toHaveLength(1)
        expect(JSON.stringify(filed)).not.toMatch(/ghp_|build-box|acme/)
      } finally {
        await rt.close()
      }
    })

    test('at most three signals per run, the best-evidenced first; the rest are reported as capped', async () => {
      const { signals, filed } = fakeSignals()
      const { entry, rt } = setup({
        signals,
        script: answer({
          proposals: [
            proposal('packages/cli/src/run.ts', 'Anecdote about the run printer', [rid(2)], 'low'),
            proposal('agents/agent-one/AGENTS.md', 'Two runs show the first mistake', [rid(0), rid(1)], 'low'),
            proposal('agents/agent-two/skills/x/SKILL.md', 'Three runs show the second mistake', [
              rid(0),
              rid(1),
              rid(2),
            ]),
            proposal('agent-two', 'Two runs show the third mistake', [rid(1), rid(2)], 'high'),
            proposal('agent-one', 'Another anecdote about agent one', [rid(0)], 'high'),
          ],
          learnings: [],
        }),
      })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
        const out = (await rt.wait(runId)).output as { signals: { status: string; title?: string }[] }
        expect(out.signals.map((s) => s.status)).toEqual(['filed', 'filed', 'filed', 'capped', 'capped'])
        expect(filed).toHaveLength(3)
        // three runs first, then the two-run one with higher confidence, then the other two-run one
        expect(filed.map((f) => f.text.match(/Evidence: (\d) of/)?.[1])).toEqual(['3', '2', '2'])
        expect(filed[1]?.text).toContain('Confidence: high')
        expect(filed[2]?.text).toContain('Confidence: low')
      } finally {
        await rt.close()
      }
    })

    test('a factory that refuses a signal is reported in the output and does not fail the run', async () => {
      const { signals } = fakeSignals({ failing: true })
      const { entry, rt } = setup({ script: answer(), signals })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
        const result = await rt.wait(runId)
        expect(result.status).toBe('done')
        const out = result.output as { signals: { status: string; reason?: string }[] }
        expect(out.signals).toMatchObject([{ status: 'failed', reason: expect.stringContaining('unreachable') }])
      } finally {
        await rt.close()
      }
    })

    test('fileSignals without a tracked-path source fails before any step', async () => {
      const { signals } = fakeSignals()
      const host = new FakeAgentHost(answer())
      const entry = createRetrospective({
        journal,
        learnings,
        signals,
        now: () => NOW,
        agentsOf: (id) => (id === wf ? agents : undefined),
      })
      const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf, fileSignals: true }, { purpose: 'build' })
        expect(await rt.wait(runId)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
      } finally {
        await rt.close()
      }
    })
  })

  describe('learnings across weeks', () => {
    test('the same fact proposed by a run of a later week is activated; the first week stays proposed and is stored once', async () => {
      const fact = 'Schema re-asks follow a missing summary field in the weekly sample'
      const learn = (at: Date, reword: string) => {
        const host = new FakeAgentHost(
          answer({ proposals: [], learnings: [{ agent: 'agent-two', fact: reword, evidence: [rid(0)] }] }),
        )
        const entry = createRetrospective({
          journal,
          learnings,
          now: () => at,
          agentsOf: (id) => (id === wf ? agents : undefined),
        })
        return { entry, rt: testRuntime({ schema: db.schema, workflows: [entry.workflow], host }) }
      }
      const outcomes: string[] = []
      for (const [at, text] of [
        [new Date('2026-10-26T12:00:00Z'), fact],
        [new Date('2026-10-28T12:00:00Z'), fact.toUpperCase()], // same week, another run
        [new Date('2026-11-03T12:00:00Z'), `The ${fact.toLowerCase()}.`], // the next week, reworded
      ] as const) {
        const { entry, rt } = learn(at, text)
        await rt.open()
        try {
          const { runId } = await rt.start(entry.workflow, { workflow: wf, window: 20 }, { purpose: 'build' })
          const out = (await rt.wait(runId)).output as { learnings: { outcome: string; learningId: number }[] }
          outcomes.push(out.learnings[0]?.outcome ?? 'none')
        } finally {
          await rt.close()
        }
      }
      expect(outcomes).toEqual(['new', 'known', 'activated'])
      const stored = await learnings.list({ agent: 'agent-two' })
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ status: 'active', weeks: ['2026-W44', '2026-W45'] })
      expect(stored[0]?.sources).toHaveLength(3)
    })
  })

  test('learned facts come before the JSON-only retry directive, which stays last', async () => {
    await learnings.add({
      agent: 'retrospective',
      fact: 'Reruns of this workflow are cached',
      source: 'manual',
      status: 'active',
    })
    let calls = 0
    const host = new FakeAgentHost(async () => ({
      output: (++calls === 1 ? { nope: 1 } : { proposals: [], learnings: [] }) as Json,
    }))
    const entry = createRetrospective({
      journal,
      learnings,
      now: () => NOW,
      agentsOf: (id) => (id === wf ? agents : undefined),
    })
    const rt = testRuntime({
      schema: db.schema,
      workflows: [entry.workflow],
      host,
      agentPrompt: async ({ agent, prompt }) => withLearnedFacts(prompt, await learnings.activeFor(agent)),
    })
    await rt.open()
    try {
      const { runId } = await rt.start(entry.workflow, { workflow: wf, window: 5 }, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('done')
      const [first, retry] = [...host.sessions.values()].map((s) => s.spec.prompt)
      expect(first).toContain('<learned_facts>')
      expect(first).not.toContain(SUBMIT_RESULT_RETRY.trim())
      expect(retry?.endsWith(SUBMIT_RESULT_RETRY)).toBe(true)
      expect((retry ?? '').indexOf('</learned_facts>')).toBeLessThan((retry ?? '').indexOf(SUBMIT_RESULT_RETRY.trim()))
    } finally {
      await rt.close()
    }
  })
})

describe('weekly schedule', () => {
  test('ISO week: the Thursday decides the year', () => {
    expect(isoWeek(new Date('2026-10-28T12:00:00Z'))).toBe('2026-W44')
    expect(isoWeek(new Date('2026-10-26T00:00:00Z'))).toBe('2026-W44') // Monday
    expect(isoWeek(new Date('2026-11-01T23:59:00Z'))).toBe('2026-W44') // Sunday
    expect(isoWeek(new Date('2026-11-02T00:00:00Z'))).toBe('2026-W45')
    expect(isoWeek(new Date('2026-12-31T00:00:00Z'))).toBe('2026-W53')
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53')
    expect(isoWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01')
    expect(retroKey('review', NOW)).toBe('retro:review:2026-W44')
  })

  const sched = 'sched.wf'
  const quiet = 'sched.quiet'

  test('one retrospective per workflow with runs, once per ISO week however often it ticks', async () => {
    await seed({ workflow: sched, daysAgo: 2 })
    await seed({ workflow: 'sched.old', daysAgo: 12 })
    const host = new FakeAgentHost(async () => ({ output: { proposals: [], learnings: [] } }))
    const entry = createRetrospective({
      journal,
      learnings,
      now: () => NOW,
      agentsOf: (id) => ([sched, quiet, 'sched.old'].includes(id) ? ['agent-one'] : undefined),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
    await rt.open()
    const logger = { warn: () => {}, error: (m: string) => failures.push(m) }
    const failures: string[] = []
    const tick = (now: Date, fileSignals = false) =>
      tickRetrospectives({
        runtime: rt,
        retrospective: entry,
        journal,
        workflows: [sched, quiet, 'sched.old'],
        fileSignals,
        logger,
        now: () => now,
      })
    const retroRuns = async () =>
      (
        await sql.pool.query(
          `select id, idempotency_key, purpose, input from "${db.schema}".runs where workflow = $1 and idempotency_key like 'retro:%' order by created_at`,
          [RETRO_WORKFLOW_ID],
        )
      ).rows as {
        id: string
        idempotency_key: string
        purpose: string
        input: { workflow: string; fileSignals: boolean }
      }[]
    try {
      const first = await tick(NOW)
      expect(first.map((s) => s.workflow)).toEqual([sched]) // none for the quiet one and the one with only old runs
      const [firstRun] = await retroRuns()
      expect(firstRun).toMatchObject({
        idempotency_key: `retro:${sched}:2026-W44`,
        purpose: 'retro',
        input: { workflow: sched, fileSignals: false },
      })

      const second = await tick(new Date(NOW.getTime() + 3_600_000)) // an hour later, same week
      expect(second).toEqual([]) // the week's run stands
      expect(await retroRuns()).toHaveLength(1)

      // The lead flips fileSignals mid-week: that week's run stands, nothing throws or doubles.
      expect(await tick(new Date(NOW.getTime() + 7_200_000), true)).toEqual([])
      expect(await retroRuns()).toHaveLength(1)
      expect(failures).toEqual([])

      // Next ISO week, runs still in the window: a new key, a new run.
      const nextWeek = new Date('2026-11-02T01:00:00Z')
      await seed({ workflow: sched, daysAgo: -3 }) // a run finished since
      await tick(nextWeek)
      expect((await retroRuns()).map((r) => r.idempotency_key)).toEqual([
        `retro:${sched}:2026-W44`,
        `retro:${sched}:2026-W45`,
      ])
      await rt.wait(firstRun?.id as string)
    } finally {
      await rt.close()
    }
  })

  describe('a failed retrospective of the week is retried, a bounded number of times', () => {
    test('nextKey: base first; running or done or cancelled stands; failed → retry-n up to the bound', () => {
      const base = 'retro:w:2026-W44'
      expect(nextKey(base, [])).toBe(base)
      for (const status of ['pending', 'running', 'done', 'cancelled'])
        expect(nextKey(base, [{ key: base, status }])).toBeNull()
      expect(nextKey(base, [{ key: base, status: 'failed' }])).toBe(`${base}:retry-1`)
      expect(
        nextKey(base, [
          { key: base, status: 'failed' },
          { key: `${base}:retry-1`, status: 'running' },
        ]),
      ).toBeNull()
      const failed = [base, ...Array.from({ length: MAX_WEEKLY_RETRIES }, (_, i) => `${base}:retry-${i + 1}`)].map(
        (key) => ({ key, status: 'failed' }),
      )
      expect(nextKey(base, failed.slice(0, MAX_WEEKLY_RETRIES))).toBe(`${base}:retry-${MAX_WEEKLY_RETRIES}`)
      expect(nextKey(base, failed)).toBeNull()
    })

    function retryRig(workflow: string) {
      let broken = true
      const host = new FakeAgentHost(async () => ({
        output: (broken ? { nope: 1 } : { proposals: [], learnings: [] }) as Json,
      }))
      const entry = createRetrospective({
        journal,
        learnings,
        now: () => NOW,
        agentsOf: (id) => (id === workflow ? ['agent-one'] : undefined),
      })
      const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
      const tick = () =>
        tickRetrospectives({
          runtime: rt,
          retrospective: entry,
          journal,
          workflows: [workflow],
          fileSignals: false,
          logger: { warn: () => {}, error: () => {} },
          now: () => NOW,
        })
      const keys = async () =>
        (
          await sql.pool.query<{ idempotency_key: string; status: string }>(
            `select idempotency_key, status from "${db.schema}".runs where workflow = 'retrospective' and idempotency_key like $1 order by created_at`,
            [`retro:${workflow}:%`],
          )
        ).rows.map((r) => `${r.idempotency_key.replace(`retro:${workflow}:2026-W44`, 'base')}=${r.status}`)
      return {
        rt,
        tick,
        keys,
        fix: () => {
          broken = false
        },
      }
    }

    test('three retries at most, then the week is left failed', async () => {
      const wfName = 'retry.cap'
      await seed({ workflow: wfName, daysAgo: 1 })
      const rig = retryRig(wfName)
      await rig.rt.open()
      try {
        for (let n = 0; n < 1 + MAX_WEEKLY_RETRIES; n++) {
          const started = await rig.tick()
          expect(started).toHaveLength(1)
          expect((await rig.rt.wait(started[0]?.runId as string)).status).toBe('failed')
        }
        expect(await rig.tick()).toEqual([]) // the bound
        expect(await rig.keys()).toEqual([
          'base=failed',
          'base:retry-1=failed',
          'base:retry-2=failed',
          'base:retry-3=failed',
        ])
      } finally {
        await rig.rt.close()
      }
    })

    test('a retry that succeeds ends it', async () => {
      const wfName = 'retry.ok'
      await seed({ workflow: wfName, daysAgo: 1 })
      const rig = retryRig(wfName)
      await rig.rt.open()
      try {
        const first = await rig.tick()
        expect((await rig.rt.wait(first[0]?.runId as string)).status).toBe('failed')
        rig.fix()
        const retry = await rig.tick()
        expect(retry.map((r) => r.key)).toEqual([`retro:${wfName}:2026-W44:retry-1`])
        expect((await rig.rt.wait(retry[0]?.runId as string)).status).toBe('done')
        expect(await rig.tick()).toEqual([])
        expect(await rig.keys()).toEqual(['base=failed', 'base:retry-1=done'])
      } finally {
        await rig.rt.close()
      }
    })
  })
})
