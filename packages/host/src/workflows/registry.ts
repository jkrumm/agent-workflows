import { relative } from 'node:path'
import type { AgentRef } from '@agent-workflows/middleware'
import type { HostWorkflow } from '../operations.ts'
import type { Suite, Suites } from './eval/suites.ts'
import type { HostDeps } from './index.ts'

/** What a module's `create` gets beside the deps: the discovered eval suites and, in the `last` phase, every workflow built before. */
export interface WorkflowContext {
  /** Every discovered module's suite, by workflow id, sorted: `agw eval run|compare` take their enum from it. */
  suites: Suites
  /** Empty in the `first` phase; in `last`, every `first`-phase module's workflows (the retrospective reads their agents). */
  peers: readonly HostWorkflow[]
}

/** One workflow directory's registration: `<dir>/<id>/module.ts` default-exports it. */
export interface WorkflowModule {
  /** The directory name. A module with a `suite` serves a workflow of this id. */
  id: string
  /**
   * `first` (default) modules are built in sorted directory order; `last` modules after all of them, with their
   * workflows as `peers`. Two phases, not an `after` graph: the retrospective is the one module that needs the others.
   */
  phase?: 'first' | 'last'
  create(deps: HostDeps, context: WorkflowContext): HostWorkflow[]
  /** The module's eval suite (`$AGW_EVAL_DIR/<id>/cases.jsonl`): `plain` (`PlainCase` lines, no tree) or its own reader. */
  suite?: 'plain' | Suite
}

/** A module as discovered: with the file it came from, which every boot error names. */
export interface DiscoveredModule extends WorkflowModule {
  file: string
}

const BRAND = Symbol.for('agent-workflows.workflow-module')

/** The default export of a `module.ts`; branded so discovery refuses any other default export. */
export function defineWorkflowModule(module: WorkflowModule): WorkflowModule {
  return Object.assign(module, { [BRAND]: true })
}

const isModule = (value: unknown): value is WorkflowModule =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true

/**
 * Every `<dir>/*\/module.ts`, imported in sorted order. One code path for every process: the host discovers
 * `src/workflows`, a second process (audio) its own tree. Fails, naming the file, on an empty dir, a default export
 * that is not a `defineWorkflowModule`, an id that is not its directory name, or a duplicate id.
 */
export async function discoverWorkflowModules(dir: string): Promise<DiscoveredModule[]> {
  const files = [...new Bun.Glob('*/module.ts').scanSync({ cwd: dir, absolute: true })].sort()
  if (files.length === 0) throw new Error(`workflow modules: no */module.ts under ${dir}`)
  const modules: DiscoveredModule[] = []
  for (const file of files) {
    const name = relative(dir, file).split(/[\\/]/)[0]
    const exported: unknown = (await import(file)).default
    if (!isModule(exported))
      throw new Error(`workflow modules: ${file}: default export is not a defineWorkflowModule(...)`)
    if (exported.id !== name)
      throw new Error(`workflow modules: ${file}: id "${exported.id}" is not its directory "${name}"`)
    modules.push({ ...exported, file })
  }
  return modules
}

/** The modules' suites, by workflow id. */
export function suitesOf(modules: readonly DiscoveredModule[]): Suites {
  return new Map(modules.flatMap((m) => (m.suite ? [[m.id, m.suite] as const] : [])))
}

/**
 * Builds every module's workflows: `first` phase in order, then `last` with the rest as peers. Fails, naming the file,
 * on a workflow id another module already registered, a suite whose module serves no workflow of its id, or an agent
 * on a route `isRoute` does not know.
 */
export function buildWorkflows(
  modules: readonly DiscoveredModule[],
  deps: HostDeps,
  isRoute: (id: string) => boolean,
): HostWorkflow[] {
  const suites = suitesOf(modules)
  const owner = new Map<string, string>()
  const built: HostWorkflow[] = []
  const add = (module: DiscoveredModule, entries: HostWorkflow[]) => {
    for (const entry of entries) {
      const id = entry.workflow.id
      const other = owner.get(id)
      if (other) throw new Error(`workflow modules: ${module.file}: workflow "${id}" is already registered by ${other}`)
      owner.set(id, module.file)
      for (const ref of entry.agents ?? []) {
        if (!isRoute(ref.route))
          throw new Error(
            `workflow modules: ${module.file}: workflow "${id}" runs agent "${ref.agent}" on unknown route "${ref.route}"`,
          )
      }
    }
    if (module.suite && !entries.some((e) => e.workflow.id === module.id))
      throw new Error(`workflow modules: ${module.file}: declares a suite but serves no workflow "${module.id}"`)
    built.push(...entries)
  }
  for (const module of modules.filter((m) => m.phase !== 'last'))
    add(module, module.create(deps, { suites, peers: [] }))
  const peers = [...built]
  for (const module of modules.filter((m) => m.phase === 'last')) add(module, module.create(deps, { suites, peers }))
  return built
}

/** The distinct agent names each hosted workflow runs: an agent listed on two routes (review's angles) counts once. */
export function agentNames(workflows: HostWorkflow[]): Map<string, string[]> {
  return new Map(
    Object.entries(fingerprintWorkflows(workflows)).map(([id, refs]) => [id, [...new Set(refs.map((r) => r.agent))]]),
  )
}

/** The agents each hosted workflow runs, for the run fingerprint; workflows without agents are left out. */
export function fingerprintWorkflows(workflows: HostWorkflow[]): Record<string, AgentRef[]> {
  return Object.fromEntries(
    workflows.filter((entry) => entry.agents?.length).map((entry) => [entry.workflow.id, entry.agents ?? []]),
  )
}
