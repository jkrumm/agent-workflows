import type { createCapabilities, Registry } from '@agent-workflows/capabilities'
import type { AgentRef } from '@agent-workflows/middleware'
import { createLearningsWorkflows, type LearningsStore } from '../learnings/index.ts'
import type { HostWorkflow } from '../operations.ts'
import { createCheckWorkflows } from './check/index.ts'
import { createRetrospective } from './retrospective/index.ts'
import type { GhPort } from './retrospective/gh.ts'
import type { JournalReader } from './retrospective/sample.ts'
import type { TrackedPaths } from './retrospective/tracked.ts'
import { createReviewWorkflows } from './review/index.ts'
import { createSmokePing } from './smoke.ts'

/** The host's capability registry: what a workflow's code steps call in-process. */
export type HostRegistry = Registry<ReturnType<typeof createCapabilities>>

/** What every workflow module is built from. A module needing more (an exec port, a clock) defaults it inside. */
export interface WorkflowDeps {
  registry: HostRegistry
  /** The journal-backed pieces of the learnings store and the retrospective; a host without a database leaves it out. */
  retro?: { journal: JournalReader; learnings: LearningsStore; gh?: GhPort; tracked?: () => Promise<TrackedPaths> }
}

/** Every workflow the host process serves. Heavy pipelines run in their own processes (concept §8). */
export function createWorkflows(deps: WorkflowDeps): HostWorkflow[] {
  const base = [createSmokePing(deps.registry), ...createReviewWorkflows(deps), ...createCheckWorkflows(deps)]
  if (!deps.retro) return base
  const { journal, learnings, gh, tracked } = deps.retro
  const agents = new Map(Object.entries(fingerprintWorkflows(base)).map(([id, refs]) => [id, refs.map((r) => r.agent)]))
  return [
    ...base,
    ...createLearningsWorkflows(learnings),
    createRetrospective({ journal, learnings, gh, tracked, agentsOf: (id) => agents.get(id) }),
  ]
}

/** The agents each hosted workflow runs, for the run fingerprint; workflows without agents are left out. */
export function fingerprintWorkflows(workflows: HostWorkflow[]): Record<string, AgentRef[]> {
  return Object.fromEntries(
    workflows.filter((entry) => entry.agents?.length).map((entry) => [entry.workflow.id, entry.agents ?? []]),
  )
}
