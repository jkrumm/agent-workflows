import { afterAll, describe, expect, test } from 'bun:test'
import type { Json, Verdict } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { freshSchema, testRuntime } from '@agent-workflows/testing/pg'
import { createNarrative } from '../src/workflows/narrative/index.ts'
import { CASES_PATH as NARRATIVE_CASES } from '../src/workflows/narrative/module.ts'
import { NarrativeReference, narrativeScorer } from '../src/workflows/narrative/scorer.ts'
import { createOverview, OVERVIEW_INPUT } from '../src/workflows/overview/index.ts'
import { CASES_PATH as OVERVIEW_CASES } from '../src/workflows/overview/module.ts'
import { OverviewReference, overviewScorer } from '../src/workflows/overview/scorer.ts'
import { createRetrospective } from '../src/workflows/retrospective/index.ts'
import { CASES_PATH as RETRO_CASES } from '../src/workflows/retrospective/module.ts'
import { RetroReference, retroScorer } from '../src/workflows/retrospective/scorer.ts'
import { plainSuite } from '../src/workflows/suite.ts'

// The eval-only `fixture` inputs: a case replays on made-up facts and touches no live source.

const db = freshSchema('evalfx')
afterAll(() => db.drop())
const caseOf = (path: string, id: string) => {
  const found = plainSuite.read(path).find((c) => c.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found
}
/** The context the eval run builds: the reference as the scorer's own schema parses it. */
const ctx = <R>(schema: { parse(value: unknown): R }, reference: unknown) => ({
  source: 'regression' as const,
  reference: schema.parse(reference),
  signal: new AbortController().signal,
})

describe('overview fixture', () => {
  test('classifies the fixture, reads no fleet and pushes nothing (the purpose lookup would allow a push)', async () => {
    const c = caseOf(OVERVIEW_CASES, 'ov-blocked-and-working')
    const calls: { facts: string; agentIds: string[] }[] = []
    const pushes: unknown[] = []
    const workflow = createOverview({
      registry: {
        call: async (_id: string, input: { facts: string; agentIds: string[] }) => {
          calls.push(input)
          return {
            model: 'm',
            agents: [
              { id: 'w-blocked', recommendation: 'answer', standing: 's', blocker: 'b', confidence: 'high' },
              { id: 'w-busy', recommendation: 'watch', standing: 's', blocker: null, confidence: 'high' },
            ],
          }
        },
      } as never,
      fleet: {
        read: async () => {
          throw new Error('the fleet must not be read')
        },
      },
      argo: { push: async (...args: unknown[]) => void pushes.push(args) } as never,
      purposeOf: async () => 'prod',
    }).workflow
    const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
    await rt.open()
    try {
      const input = c.input('', {})
      expect(OVERVIEW_INPUT.parse(input).fixture).toBeDefined()
      const { runId } = await rt.start(workflow, input, { purpose: 'eval' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.agentIds.toSorted()).toEqual(['w-blocked', 'w-busy'])
      expect(calls[0]?.facts).toContain('Shall I run it against production?')
      expect(pushes).toEqual([])
      const verdict = overviewScorer.score(input, result.output, ctx(OverviewReference, c.reference)) as Verdict
      expect(verdict.pass).toBe(true)
    } finally {
      await rt.close()
    }
  })

  test('without a fixture the fleet is read as before', async () => {
    let reads = 0
    const workflow = createOverview({
      registry: { call: async () => ({ agents: [], model: 'm' }) } as never,
      fleet: {
        read: async () => {
          reads += 1
          return { snapshot: { generatedAt: 1, projects: [] } as never, unreadable: null }
        },
      },
    }).workflow
    const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
    await rt.open()
    try {
      const { runId } = await rt.start(workflow, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('done')
      expect(reads).toBe(1)
    } finally {
      await rt.close()
    }
  })
})

describe('narrative fixture', () => {
  const unusable = async () => {
    throw new Error('git and transcripts must not be read')
  }
  const gather = { projectsDir: '/projects', git: unusable, sessionFiles: unusable, readTail: unusable }

  test('composes from the fixture commits in git-log shape, with no sessions, and the scorer passes a good answer', async () => {
    const c = caseOf(NARRATIVE_CASES, 'nar-bootstrap-features')
    const composed: { commitsText: string; commitCount: number; sessionCount: number; sinceUsed: string }[] = []
    const [narrative, polish] = createNarrative({
      registry: {
        call: async (_id: string, input: (typeof composed)[number]) => {
          composed.push(input)
          return {
            changed: true,
            reason: 'Alerts and a cache.',
            summary: 'Push alerts and an hourly forecast cache landed.',
            sections: {
              whatItIs:
                'A forecast app with push alerts for severe weather and a cache that survives provider outages.',
              whereItStands: ['Push alerts are live for opted-in cities.', 'Forecasts are cached for an hour.'],
              howItGotHere: [{ date: '2026-10-28', text: 'Added opt-in push alerts.' }],
              openQuestions: [],
            },
            model: 'm',
          }
        },
      } as never,
      gather,
      now: () => new Date('2026-11-03T10:00:00Z'),
    }) as [{ workflow: never }, { workflow: never }]
    const rt = testRuntime({ schema: db.schema, workflows: [narrative.workflow, polish.workflow] })
    await rt.open()
    try {
      const input = c.input('', {})
      const { runId } = await rt.start(narrative.workflow, input, { purpose: 'eval' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      expect(composed).toHaveLength(1)
      expect(composed[0]).toMatchObject({ commitCount: 4, sessionCount: 0 })
      expect(composed[0]?.commitsText).toMatch(
        /^f3a91c2 2026-10-28T10:00:00\+00:00 feat: push alerts for severe weather\n/,
      )
      const verdict = narrativeScorer.score(input, result.output, ctx(NarrativeReference, c.reference)) as Verdict
      expect(verdict.pass).toBe(true)
    } finally {
      await rt.close()
    }
  })

  test('a fixture with no commits answers unchanged without a model call', async () => {
    const c = caseOf(NARRATIVE_CASES, 'nar-no-commits')
    const [narrative, polish] = createNarrative({
      registry: {
        call: async () => {
          throw new Error('no model call expected')
        },
      },
      gather,
    }) as [{ workflow: never }, { workflow: never }]
    const rt = testRuntime({ schema: db.schema, workflows: [narrative.workflow, polish.workflow] })
    await rt.open()
    try {
      const input = c.input('', {})
      const { runId } = await rt.start(narrative.workflow, input, { purpose: 'eval' })
      const result = await rt.wait(runId)
      expect(result.output).toMatchObject({ changed: false, page: null, inputs: { commits: 0, sessions: 0 } })
      expect((narrativeScorer.score(input, result.output, ctx(NarrativeReference, c.reference)) as Verdict).pass).toBe(
        true,
      )
    } finally {
      await rt.close()
    }
  })
})

describe('retrospective fixture', () => {
  test('analyzes the fixture runs, reads no journal, stores no learning and files no issue', async () => {
    const c = caseOf(RETRO_CASES, 'retro-reinstall-timeouts')
    const answer = {
      proposals: [
        {
          kind: 'agents-md',
          target: 'agents/check/AGENTS.md',
          title: 'Tell the agent the dependencies are already installed',
          change:
            'Five runs reinstalled dependencies after each failure and timed out; state that the install is done once.',
          evidence: ['chk-a-000001', 'chk-a-000002'],
          confidence: 'high',
        },
      ],
      learnings: [
        { agent: 'check', fact: 'A reinstall after a failed check restarts the timeout', evidence: ['chk-a-000003'] },
      ],
    }
    const host = new FakeAgentHost(async () => ({ output: answer }))
    let added = 0
    let sampled = 0
    const workflow = createRetrospective({
      journal: {
        sample: async () => {
          sampled += 1
          return []
        },
        countFinished: async () => 0,
        weekRuns: async () => [],
      },
      learnings: {
        add: async () => {
          added += 1
          throw new Error('a fixture run stores nothing')
        },
      } as never,
      agentsOf: (id) => (id === 'check' ? ['check'] : undefined),
    }).workflow
    const rt = testRuntime({ schema: db.schema, workflows: [workflow], host })
    await rt.open()
    try {
      const input = { ...c.input('', {}), fileIssues: true }
      const { runId } = await rt.start(workflow, input, { purpose: 'eval' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      expect(result.output).toMatchObject({
        sampled: 8,
        issues: [],
        dropped: [],
        learnings: [{ agent: 'check', learningId: null }],
      })
      expect(added).toBe(0)
      expect(sampled).toBe(0)
      const prompt = [...host.sessions.values()][0]?.spec.prompt ?? ''
      expect(prompt).toContain('chk-a-000001')
      expect(prompt).toContain('bun install')
      const verdict = retroScorer.score(c.input('', {}), result.output, ctx(RetroReference, c.reference)) as Verdict
      expect(verdict.pass).toBe(true)
    } finally {
      await rt.close()
    }
  })
})

describe('a fixture is refused unless the run is an eval', () => {
  const REFUSED = /fixture is an eval-only input, refused for a run with purpose "prod"/

  test('overview: no classify call, no fleet read, no push, and the failure names the cause', async () => {
    const c = caseOf(OVERVIEW_CASES, 'ov-blocked-and-working')
    const touched: string[] = []
    const workflow = createOverview({
      registry: {
        call: async () => {
          touched.push('classify')
          return { agents: [], model: 'm' }
        },
      } as never,
      fleet: {
        read: async () => {
          touched.push('fleet')
          throw new Error('unreachable')
        },
      },
      argo: { push: async () => void touched.push('push') } as never,
      purposeOf: async () => 'prod',
    }).workflow
    const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
    await rt.open()
    try {
      const { runId } = await rt.start(workflow, c.input('', {}), { purpose: 'prod' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(result.error?.message).toMatch(REFUSED)
      expect(touched).toEqual([])
    } finally {
      await rt.close()
    }
  })

  test('narrative: no composer call and no gathering', async () => {
    const c = caseOf(NARRATIVE_CASES, 'nar-bootstrap-features')
    let called = 0
    const [narrative, polish] = createNarrative({
      registry: {
        call: async () => {
          called += 1
          throw new Error('unreachable')
        },
      },
      gather: {
        projectsDir: '/projects',
        git: async () => {
          called += 1
          return ''
        },
        sessionFiles: async () => [],
        readTail: async () => '',
      },
    }) as [{ workflow: never }, { workflow: never }]
    const rt = testRuntime({ schema: db.schema, workflows: [narrative.workflow, polish.workflow] })
    await rt.open()
    try {
      const { runId } = await rt.start(narrative.workflow, c.input('', {}), { purpose: 'prod' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(result.error?.message).toMatch(REFUSED)
      expect(called).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('retrospective: no analysis step and nothing stored', async () => {
    const c = caseOf(RETRO_CASES, 'retro-reinstall-timeouts')
    const host = new FakeAgentHost(async () => ({ output: { proposals: [], learnings: [] } }))
    const workflow = createRetrospective({
      journal: { sample: async () => [], countFinished: async () => 0, weekRuns: async () => [] },
      learnings: {
        add: async () => {
          throw new Error('unreachable')
        },
      } as never,
      agentsOf: (id) => (id === 'check' ? ['check'] : undefined),
    }).workflow
    const rt = testRuntime({ schema: db.schema, workflows: [workflow], host })
    await rt.open()
    try {
      const { runId } = await rt.start(workflow, c.input('', {}), { purpose: 'prod' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(result.error?.message).toMatch(REFUSED)
      expect(host.count('open')).toBe(0)
    } finally {
      await rt.close()
    }
  })
})
