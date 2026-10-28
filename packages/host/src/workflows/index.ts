import type { AgentRef } from '@agent-workflows/middleware'
import type { HostWorkflow } from '../operations.ts'
import { createSmokePing, type TitleCaller } from './smoke.ts'

/** Every workflow the host process serves. Heavy pipelines run in their own processes (concept §8). */
export function createWorkflows(registry: TitleCaller): HostWorkflow[] {
  return [createSmokePing(registry)]
}

/** The agents each hosted workflow runs, for the run fingerprint; workflows without agents are left out. */
export function fingerprintWorkflows(workflows: HostWorkflow[]): Record<string, AgentRef[]> {
  return Object.fromEntries(
    workflows.filter((entry) => entry.agents?.length).map((entry) => [entry.workflow.id, entry.agents ?? []]),
  )
}
