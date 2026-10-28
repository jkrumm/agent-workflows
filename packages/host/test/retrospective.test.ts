import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Json } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { pgLearningsStore } from '../src/learnings/index.ts'
import type { GhPort, IssueRef } from '../src/workflows/retrospective/gh.ts'
import { createRetrospective, RETRO_WORKFLOW_ID } from '../src/workflows/retrospective/index.ts'
import { pgJournalReader } from '../src/workflows/retrospective/sample.ts'
import { isoWeek, retroKey, tickRetrospectives } from '../src/workflows/retrospective/schedule.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

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

  test('step outputs are cut to a preview', async () => {
    const big = await seed({ workflow: 'sample.big', steps: [{ id: 'a', output: { text: 'x'.repeat(5000) } }] })
    const [run] = await journal.sample({ workflow: 'sample.big', since: since(7), limit: 1 })
    expect(run?.runId).toBe(big)
    expect(run?.steps[0]?.output?.length).toBeLessThanOrEqual(1200)
  })
})

/** A `gh` port that remembers issues; `existing` titles are already filed. */
function fakeGh(existing: string[] = []) {
  const issues = new Map<string, IssueRef>(
    existing.map((t, i) => [t.toLowerCase(), { number: i + 1, url: `https://example.com/issues/${i + 1}` }]),
  )
  const calls = { find: [] as string[], create: [] as { title: string; body: string }[] }
  const gh: GhPort = {
    async findByTitle(title) {
      calls.find.push(title)
      return issues.get(title.toLowerCase()) ?? null
    },
    async create(issue) {
      calls.create.push(issue)
      const ref = { number: issues.size + 1, url: `https://example.com/issues/${issues.size + 1}` }
      issues.set(issue.title.toLowerCase(), ref)
      return ref
    },
  }
  return { gh, calls }
}

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

  function setup(options: { script?: ConstructorParameters<typeof FakeAgentHost>[0]; gh?: GhPort } = {}) {
    const host = new FakeAgentHost(options.script)
    const entry = createRetrospective({
      journal,
      learnings,
      gh: options.gh,
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
        issues: [],
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
            target: 'other-repo/src/a.ts',
            title: 'Target outside this repository',
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
      expect(out.dropped.join('\n')).toContain('outside this repo')
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
      expect((await rt.wait(runId)).output).toMatchObject({ sampled: 0, proposals: [], learnings: [], issues: [] })
      expect(host.count('open')).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('a workflow without agents, or fileIssues with no issue port, fails before any step', async () => {
    const { entry, rt } = setup({ script: answer() })
    await rt.open()
    try {
      const unknown = await rt.start(entry.workflow, { workflow: 'smoke.ping' }, { purpose: 'build' })
      expect(await rt.wait(unknown.runId)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
      const noGh = await rt.start(entry.workflow, { workflow: wf, fileIssues: true }, { purpose: 'build' })
      expect(await rt.wait(noGh.runId)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
    } finally {
      await rt.close()
    }
  })

  describe('issues', () => {
    test('off by default: the port is never called', async () => {
      const { gh, calls } = fakeGh()
      const { entry, rt } = setup({ script: answer(), gh })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf }, { purpose: 'build' })
        const out = (await rt.wait(runId)).output as { issues: unknown[] }
        expect(out.issues).toEqual([])
        expect(calls).toEqual({ find: [], create: [] })
      } finally {
        await rt.close()
      }
    })

    test('on: filed once with the proposal text, target and run ids only; the next week dedupes by title', async () => {
      const { gh, calls } = fakeGh()
      const { entry, rt } = setup({ script: answer(), gh })
      await rt.open()
      try {
        const first = await rt.start(entry.workflow, { workflow: wf, fileIssues: true }, { purpose: 'build' })
        const out = (await rt.wait(first.runId)).output as { issues: { status: string; title: string; url?: string }[] }
        expect(out.issues).toEqual([
          {
            title: `retro(${wf}): Tell agent-one to confirm the schema first`,
            status: 'filed',
            url: 'https://example.com/issues/1',
          },
        ])
        expect(calls.create).toHaveLength(1)
        const body = calls.create[0]?.body ?? ''
        expect(body).toContain('`agents/agent-one/AGENTS.md`')
        expect(body).toContain(`\`${rid(0)}\``)
        for (const leak of ['PRIVATE-INPUT-MARKER', '/Users', 'acme-corp', 'cwd']) expect(body).not.toContain(leak)

        const second = await rt.start(
          entry.workflow,
          { workflow: wf, fileIssues: true, window: 6 },
          { purpose: 'build' },
        )
        const again = (await rt.wait(second.runId)).output as { issues: { status: string }[] }
        expect(again.issues.map((i) => i.status)).toEqual(['duplicate'])
        expect(calls.create).toHaveLength(1)
      } finally {
        await rt.close()
      }
    })

    test('a proposal quoting a repository is refused, not filed; the others still are', async () => {
      const { gh, calls } = fakeGh()
      const { entry, rt } = setup({
        gh,
        script: answer({
          proposals: [
            {
              kind: 'skill',
              target: 'agents/agent-two/skills/x/SKILL.md',
              title: 'Quote the private repository in a skill',
              change: 'In acme-corp/payments-api the skill fails.',
              evidence: [rid(1)],
              confidence: 'low',
            },
            {
              kind: 'cli',
              target: 'agw check',
              title: 'Print the failing step name first',
              change: 'Agents grep the output for the step name.',
              evidence: [rid(1), rid(2)],
              confidence: 'high',
            },
          ],
          learnings: [],
        }),
      })
      await rt.open()
      try {
        const { runId } = await rt.start(entry.workflow, { workflow: wf, fileIssues: true }, { purpose: 'build' })
        const out = (await rt.wait(runId)).output as {
          proposals: unknown[]
          issues: { status: string; reason?: string }[]
        }
        expect(out.proposals).toHaveLength(2) // reported, even when not filed
        expect(out.issues.map((i) => i.status)).toEqual(['refused', 'filed'])
        expect(out.issues[0]?.reason).toContain('outside this repo')
        expect(calls.create.map((c) => c.title)).toEqual([`retro(${wf}): Print the failing step name first`])
        expect(JSON.stringify(calls)).not.toContain('acme-corp')
      } finally {
        await rt.close()
      }
    })
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
    const tick = (now: Date, fileIssues = false) =>
      tickRetrospectives({
        runtime: rt,
        retrospective: entry,
        journal,
        workflows: [sched, quiet, 'sched.old'],
        fileIssues,
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
        input: { workflow: string; fileIssues: boolean }
      }[]
    try {
      const first = await tick(NOW)
      expect(first.map((s) => s.workflow)).toEqual([sched]) // none for the quiet one and the one with only old runs
      const [firstRun] = await retroRuns()
      expect(firstRun).toMatchObject({
        idempotency_key: `retro:${sched}:2026-W44`,
        purpose: 'retro',
        input: { workflow: sched, fileIssues: false },
      })

      const second = await tick(new Date(NOW.getTime() + 3_600_000)) // an hour later, same week
      expect(second[0]?.runId).toBe(firstRun?.id as string)
      expect(await retroRuns()).toHaveLength(1)

      // The lead flips fileIssues mid-week: that week's run stands, nothing throws or doubles.
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
})
