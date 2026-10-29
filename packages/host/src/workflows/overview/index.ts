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
 * `overview` (the agent-gateway `overview` job): one classify call over the fleet. A fresh snapshot is the first step,
 * then one `overview.classify` call gives every agent a recommendation; the verdicts are merged onto the snapshot's own
 * ids. `agw agents` serves the newest completed run beside a fresh snapshot, so the run's output is the cache.
 *
 * The journal keeps what classify needs (the facts text and the ids) and the verdicts, never the snapshot with its
 * transcript excerpts and queued commands.
 */
export function createOverview(deps: OverviewDeps): HostWorkflow {
  const now = deps.now ?? Date.now
  const workflow = defineWorkflow({
    id: OVERVIEW_WORKFLOW_ID,
    version: '2026-10-29.2',
    input: OVERVIEW_INPUT,
    output: OVERVIEW_OUTPUT,
    // One run at a time is plenty: the fleet changes slower than a run takes, and the call is the only spend.
    concurrency: 1,
    async run(ctx, input) {
      const prepared = await ctx.step('snapshot', async () =>
        classifyInput(await deps.fleet.snapshot({ fresh: true, staleAfterHours: input.staleAfterHours }), {
          maxChars: MAX_OVERVIEW_FACTS_CHARS,
          maxAgents: MAX_OVERVIEW_AGENTS,
        }),
      )
      // No agent, no call: nothing to classify, and the model would be asked for an empty list.
      const answer =
        prepared.agentIds.length === 0
          ? { agents: [], model: 'none', generatedAt: now() }
          : await ctx.step('classify', async ({ addUsage, signal }) => ({
              ...(await deps.registry.call(
                'overview.classify',
                { facts: prepared.facts, agentIds: prepared.agentIds },
                { addUsage, signal },
              )),
              generatedAt: now(), // inside the step: a resumed run reads the time back, never takes a new one
            }))
      const output = reconcileKnown(
        prepared.generatedAt,
        new Map(prepared.known.map((k) => [k.id, k])),
        answer.agents,
        answer.model,
        answer.generatedAt,
      )
      // The run's own output stands in for the stored one, which is not written until the run ends.
      await ctx.effect('push', async () => {
        if (!deps.argo) return null
        if ((await deps.purposeOf?.(ctx.runId)) !== 'prod') return null
        await deps.argo.push('run', output).catch(() => {}) // telemetry: it never fails the run
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
