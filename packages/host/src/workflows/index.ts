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

let discovered: Promise<readonly DiscoveredModule[]> | undefined

/**
 * Every `src/workflows/<id>/module.ts`, discovered on first use and memoised; never at import, so a module (or any
 * importer of this file's types and helpers) loads nothing until the host builds. Heavy pipelines run in their own
 * processes (concept §8).
 */
export function hostModules(): Promise<readonly DiscoveredModule[]> {
  discovered ??= discoverWorkflowModules(import.meta.dir)
  return discovered
}

/** Every workflow the host process serves: each module's (default: the host's tree), built from `deps`. */
export async function createWorkflows(deps: HostDeps, modules?: readonly DiscoveredModule[]): Promise<HostWorkflow[]> {
  const list = modules ?? (await hostModules())
  // The gate refuses to grant an agent a mutating or unknown capability: it learns what the registry serves. An internal
  // capability (a metered seat whose guards live in a workflow) is unknown to it, so no agent is ever granted one.
  deps.toolGate.setCapabilities((id) => deps.registry.served.find((c) => c.id === id)?.cli)
  const known = new Set<string>(routeIds())
  return buildWorkflows(list, deps, (id) => known.has(id))
}
