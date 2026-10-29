import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type ArgoPush, agentIds, buildAgentFacts, type Fleet, reconcileOverview } from '../../fleet/index.ts'
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
  now?: () => number
}

/**
 * `overview` (the agent-gateway `overview` job): one classify call over the fleet. A fresh snapshot is the first step,
 * then one `overview.classify` call gives every agent a recommendation; the verdicts are merged onto the snapshot's own
 * ids. `agw agents` serves the newest completed run beside a fresh snapshot, so the run's output is the cache.
 */
export function createOverview(deps: OverviewDeps): HostWorkflow {
  const now = deps.now ?? Date.now
  const workflow = defineWorkflow({
    id: OVERVIEW_WORKFLOW_ID,
    version: '2026-10-29.1',
    input: OVERVIEW_INPUT,
    output: OVERVIEW_OUTPUT,
    // One run at a time is plenty: the fleet changes slower than a run takes, and the call is the only spend.
    concurrency: 1,
    async run(ctx, input) {
      // JSON round trip: the journal stores the step's result, and a resumed run must see exactly it.
      const snapshot = await ctx.step('snapshot', async () =>
        JSON.parse(JSON.stringify(await deps.fleet.snapshot({ fresh: true, staleAfterHours: input.staleAfterHours }))),
      )
      const ids = agentIds(snapshot)
      // No agent, no call: nothing to classify, and the model would be asked for an empty list.
      const verdicts =
        ids.length === 0
          ? { agents: [], model: 'none' }
          : await ctx.step('classify', ({ addUsage, signal }) =>
              deps.registry.call(
                'overview.classify',
                { facts: buildAgentFacts(snapshot), agentIds: ids },
                { addUsage, signal },
              ),
            )
      const output = reconcileOverview(snapshot, verdicts.agents, verdicts.model, now())
      // The run's own output stands in for the stored one, which is not written until the run ends.
      await ctx.effect('push', async () => {
        await deps.argo?.push('run', output).catch(() => {}) // telemetry: it never fails the run
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
