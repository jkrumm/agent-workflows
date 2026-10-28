import type { createCapabilities, Registry } from '@agent-workflows/capabilities'
import type { AgentRef } from '@agent-workflows/middleware'
import type { HostWorkflow } from '../operations.ts'
import { createCheckWorkflows } from './check/index.ts'
import { createReviewWorkflows } from './review/index.ts'
import { createSmokePing } from './smoke.ts'

/** The host's capability registry: what a workflow's code steps call in-process. */
export type HostRegistry = Registry<ReturnType<typeof createCapabilities>>

/** What every workflow module is built from. A module needing more (an exec port, a clock) defaults it inside. */
export interface WorkflowDeps {
  registry: HostRegistry
}

/** Every workflow the host process serves. Heavy pipelines run in their own processes (concept §8). */
export function createWorkflows(deps: WorkflowDeps): HostWorkflow[] {
  return [createSmokePing(deps.registry), ...createReviewWorkflows(deps), ...createCheckWorkflows(deps)]
}

/** The agents each hosted workflow runs, for the run fingerprint; workflows without agents are left out. */
export function fingerprintWorkflows(workflows: HostWorkflow[]): Record<string, AgentRef[]> {
  return Object.fromEntries(
    workflows.filter((entry) => entry.agents?.length).map((entry) => [entry.workflow.id, entry.agents ?? []]),
  )
}
