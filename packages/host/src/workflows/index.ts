import type { createCapabilities, Registry } from '@agent-workflows/capabilities'
import { routeIds } from '@agent-workflows/routes'
import type { Logger } from '@agent-workflows/runtime'
import type { LearningsStore } from '../learnings/index.ts'
import type { HostWorkflow } from '../operations.ts'
import type { ToolGate } from '../tool-gate/index.ts'
import { buildWorkflows, type DiscoveredModule, discoverWorkflowModules } from './registry.ts'
import type { ToolLedger } from './research/ledger.ts'
import type { GhPort } from './retrospective/gh.ts'
import type { JournalReader } from './retrospective/sample.ts'
import type { TrackedPaths } from './retrospective/tracked.ts'

export {
  agentNames,
  buildWorkflows,
  type DiscoveredModule,
  defineWorkflowModule,
  discoverWorkflowModules,
  fingerprintWorkflows,
  suitesOf,
  type WorkflowContext,
  type WorkflowModule,
} from './registry.ts'

/** The host's capability registry: what a workflow's code steps call in-process. */
export type HostRegistry = Registry<ReturnType<typeof createCapabilities>>

/** What every workflow module is built from. A module needing more (an exec port, a clock) defaults it inside. */
export interface WorkflowDeps {
  registry: HostRegistry
  /** The journal-backed pieces of the learnings store and the retrospective; a host without a database leaves it out. */
  retro?: { journal: JournalReader; learnings: LearningsStore; gh?: GhPort; tracked?: () => Promise<TrackedPaths> }
  /** Where research's tool gate records every call (Postgres on the host); absent: in memory. */
  research?: { ledger: ToolLedger }
  /** The host's one tool gate; see `HostDeps`. */
  toolGate?: ToolGate
  /** Where a workflow's non-fatal failures (a hook, a ledger write) are logged; default: nowhere. */
  logger?: Logger
}

/** What the host builds its workflows from: `WorkflowDeps` plus its one tool gate, which a workflow that gives its agent tools opens a grant on. Two gates would fight over one `gate.json`, so there is no per-workflow fallback. */
export type HostDeps = WorkflowDeps & { toolGate: ToolGate }

/** Every `src/workflows/<id>/module.ts`, discovered once per process at import. Heavy pipelines run in their own processes (concept §8). */
export const HOST_MODULES: readonly DiscoveredModule[] = await discoverWorkflowModules(import.meta.dir)

/** Every workflow the host process serves: each module's, built from `deps`. */
export function createWorkflows(deps: HostDeps, modules: readonly DiscoveredModule[] = HOST_MODULES): HostWorkflow[] {
  // The gate refuses to grant an agent a mutating or unknown capability: it learns what the registry holds.
  deps.toolGate.setCapabilities((id) => deps.registry.capabilities.find((c) => c.id === id)?.cli)
  const known = new Set<string>(routeIds())
  return buildWorkflows(modules, deps, (id) => known.has(id))
}
