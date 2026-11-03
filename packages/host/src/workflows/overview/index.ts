import { MAX_OVERVIEW_AGENTS, MAX_OVERVIEW_FACTS_CHARS } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type ArgoPush, classifyInput, type Fleet, reconcileKnown } from '../../fleet/index.ts'
import { AGENT, OVERVIEW_OUTPUT, PROJECT, PROJECT_GIT } from '../../fleet/schema.ts'
import type { HostWorkflow } from '../../operations.ts'
import { requireEvalPurpose } from '../eval-fixture.ts'
import type { HostRegistry } from '../index.ts'
import { overviewScorer } from './scorer.ts'

export const OVERVIEW_WORKFLOW_ID = 'overview'

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().default(null)

/** A fixture agent: the facts the classify seat reads (`state`, titles, activity), every other field defaults to null. */
const FIXTURE_AGENT = AGENT.extend({
  source: AGENT.shape.source.default('factory'),
  sessionId: nullable(z.string()),
  paneId: nullable(z.string()),
  workspaceId: nullable(z.string()),
  title: nullable(z.string()),
  herdrStatus: nullable(AGENT.shape.herdrStatus.unwrap()),
  claudeStatus: nullable(AGENT.shape.claudeStatus.unwrap()),
  waitingFor: nullable(z.string()),
  lastPrompt: nullable(z.string()),
  lastReply: nullable(z.string()),
  lastActivityAt: nullable(z.number()),
  startedAt: nullable(z.number()),
})

const FIXTURE_PROJECT = PROJECT.extend({
  cwd: z.string().default(''),
  git: nullable(PROJECT_GIT),
  agents: z.array(FIXTURE_AGENT),
})

export const OVERVIEW_INPUT = z.object({
  fixture: z
    .object({ generatedAt: z.number(), projects: z.array(FIXTURE_PROJECT) })
    .optional()
    .describe('Eval only: classify these projects and agents instead of reading the factory, and push nothing to Argo'),
  staleAfterHours: z
    .number()
    .positive()
    .optional()
    .describe(
      'Override the stale-agent threshold (default 24 h, `AGW_AGENT_STALE_HOURS`) of the snapshot this run classifies',
    ),
})

export interface OverviewDeps {
  registry: Pick<HostRegistry, 'call'>
  fleet: Pick<Fleet, 'read'>
  /** Pushes the completed run to Argo; never fatal. */
  argo?: Pick<ArgoPush, 'push'>
  /**
   * The purpose the run was started with (`prod`, `build`, `verify`, …): the context a workflow sees does not carry it,
   * so the host reads it from the journal. The push goes out for `prod` only: a build or verify run must not put its
   * fixtures into the owner's fleet view.
   */
  purposeOf?: (runId: string) => Promise<string | null>
  /** Where a non-fatal failure is logged (the push effect's); default: nowhere. */
  warn?: (message: string, meta?: Record<string, unknown>) => void
  now?: () => number
}

/**
 * `overview` (the agent-gateway `overview` job): one classify step over the fleet. The step takes a fresh snapshot,
 * builds the facts from it and makes the one `overview.classify` call; the verdicts are merged onto the snapshot's own
 * ids. `agw agents` serves the newest completed prod run beside a fresh snapshot, so the run's output is the cache.
 *
 * The facts (the factory's titles and headlines) are built and used inside the step and never leave it: the journal
 * keeps the agent ids, a hash of the facts and the verdicts. A completed step is read back on resume, never re-run.
 */
export function createOverview(deps: OverviewDeps): HostWorkflow {
  const now = deps.now ?? Date.now
  const workflow = defineWorkflow({
    id: OVERVIEW_WORKFLOW_ID,
    version: '2026-11-03.2',
    scorer: overviewScorer,
    input: OVERVIEW_INPUT,
    output: OVERVIEW_OUTPUT,
    // One run at a time is plenty: the fleet changes slower than a run takes, and the call is the only spend.
    concurrency: 1,
    async run(ctx, input) {
      const classified = await ctx.step('classify', async ({ callContext }) => {
        if (input.fixture) requireEvalPurpose(callContext, OVERVIEW_WORKFLOW_ID)
        const { snapshot, unreadable } = input.fixture
          ? { snapshot: input.fixture, unreadable: null }
          : await deps.fleet.read({ fresh: true, staleAfterHours: input.staleAfterHours })
        // An unreadable factory is not an empty fleet: classifying it would reconcile every verdict against nothing.
        // The step fails with the cause, so the run is `failed` and nothing is classified or pushed.
        if (unreadable) throw new Error(`overview cannot classify: ${unreadable}`)
        const prepared = classifyInput(snapshot, {
          maxChars: MAX_OVERVIEW_FACTS_CHARS,
          maxAgents: MAX_OVERVIEW_AGENTS,
        })
        // No agent, no call: nothing to classify, and the model would be asked for an empty list.
        const answer =
          prepared.agentIds.length === 0
            ? { agents: [], model: 'none' }
            : await deps.registry.call(
                'overview.classify',
                { facts: prepared.facts, agentIds: prepared.agentIds },
                callContext,
              )
        return {
          snapshotGeneratedAt: prepared.generatedAt,
          known: prepared.known,
          agentIds: prepared.agentIds,
          factsHash: new Bun.CryptoHasher('sha256').update(prepared.facts).digest('hex'),
          agents: answer.agents,
          model: answer.model,
          generatedAt: now(), // inside the step: a resumed run reads the time back, never takes a new one
        }
      })
      const output = reconcileKnown(
        classified.snapshotGeneratedAt,
        new Map(classified.known.map((k) => [k.id, k])),
        classified.agents,
        classified.model,
        classified.generatedAt,
      )
      // The run's own output stands in for the stored one, which is not written until the run ends.
      await ctx.effect('push', async () => {
        if (!deps.argo || input.fixture) return null
        try {
          // The purpose lookup is a Postgres read: telemetry never fails the run, and neither does the gate in front of it.
          if ((await deps.purposeOf?.(ctx.runId)) !== 'prod') return null
          await deps.argo.push('run', output)
        } catch (error) {
          // never fatal, but not silent
          deps.warn?.('overview push effect failed', { runId: ctx.runId, error: String(error) })
        }
        return null
      })
      return output
    },
  })
  return {
    workflow,
    summary: 'Classify every agent on the host: one recommendation, standing line and blocker each',
    cli: { defaultFormat: 'json' },
  }
}
