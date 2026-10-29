import { MAX_OVERVIEW_AGENTS, MAX_OVERVIEW_FACTS_CHARS } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type ArgoPush, classifyInput, type Fleet, reconcileKnown } from '../../fleet/index.ts'
import { OVERVIEW_OUTPUT } from '../../fleet/schema.ts'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'

export const OVERVIEW_WORKFLOW_ID = 'overview'

export const OVERVIEW_INPUT = z.object({
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
  fleet: Pick<Fleet, 'snapshot'>
  /** Pushes the completed run to Argo; never fatal. */
  argo?: Pick<ArgoPush, 'push'>
  /**
   * The purpose the run was started with (`prod`, `build`, `verify`, …): the context a workflow sees does not carry it,
   * so the host reads it from the journal. The push goes out for `prod` only: a build or verify run must not put its
   * fixtures into the owner's fleet view.
   */
  purposeOf?: (runId: string) => Promise<string | null>
  now?: () => number
}

/**
 * `overview` (the agent-gateway `overview` job): one classify step over the fleet. The step takes a fresh snapshot,
 * builds the facts from it and makes the one `overview.classify` call; the verdicts are merged onto the snapshot's own
 * ids. `agw agents` serves the newest completed prod run beside a fresh snapshot, so the run's output is the cache.
 *
 * The facts (transcript excerpts, queued commands) are built and used inside the step and never leave it: the journal
 * keeps the agent ids, a hash of the facts and the verdicts. A completed step is read back on resume, never re-run.
 */
export function createOverview(deps: OverviewDeps): HostWorkflow {
  const now = deps.now ?? Date.now
  const workflow = defineWorkflow({
    id: OVERVIEW_WORKFLOW_ID,
    version: '2026-10-29.3',
    input: OVERVIEW_INPUT,
    output: OVERVIEW_OUTPUT,
    // One run at a time is plenty: the fleet changes slower than a run takes, and the call is the only spend.
    concurrency: 1,
    async run(ctx, input) {
      const classified = await ctx.step('classify', async ({ addUsage, signal }) => {
        const prepared = classifyInput(
          await deps.fleet.snapshot({ fresh: true, staleAfterHours: input.staleAfterHours }),
          {
            maxChars: MAX_OVERVIEW_FACTS_CHARS,
            maxAgents: MAX_OVERVIEW_AGENTS,
          },
        )
        // No agent, no call: nothing to classify, and the model would be asked for an empty list.
        const answer =
          prepared.agentIds.length === 0
            ? { agents: [], model: 'none' }
            : await deps.registry.call(
                'overview.classify',
                { facts: prepared.facts, agentIds: prepared.agentIds },
                { addUsage, signal },
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
        if (!deps.argo) return null
        try {
          // The purpose lookup is a Postgres read: telemetry never fails the run, and neither does the gate in front of it.
          if ((await deps.purposeOf?.(ctx.runId)) !== 'prod') return null
          await deps.argo.push('run', output)
        } catch {
          // never fatal
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
