import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import type { AgentRef } from '@agent-workflows/middleware'
import { type AnyWorkflow, defineWorkflow, type Logger, type WorkflowDefinition } from '@agent-workflows/runtime'
import type { z } from 'zod'
import type { HostWorkflow } from '../operations.ts'
import type { Suite, Suites } from './suite.ts'
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
  /** The directory name. A module with a `suite` serves a workflow of this id, or none at all on a host that lacks its dependencies. */
  id: string
  /**
   * `first` (default) modules are built in sorted directory order; `last` modules after all of them, with their
   * workflows as `peers`. Two phases, not an `after` graph: the retrospective is the one module that needs the others.
   */
  phase?: 'first' | 'last'
  create(deps: HostDeps, context: WorkflowContext): HostWorkflow[]
  /** The module's eval suite (`$AGW_EVAL_DIR/<id>/cases.jsonl`): `plain` (`PlainCase` lines, no tree) or its own reader. */
  suite?: 'plain' | Suite
  /**
   * The workflows this module serves in another process, as a process that does not serve them can know them: id,
   * version, schemas and scorer, with a body that refuses to run (`foreignOf`). Called, with no deps, only when another
   * process's tree is loaded (`discoverForeignModules`) so `agw eval` can start and score their runs; `create` is not.
   */
  foreign?(): AnyWorkflow[]
}

/** A module as discovered: with the file it came from, which every boot error names. */
export interface DiscoveredModule extends WorkflowModule {
  file: string
  /**
   * Set on a module of another process's tree (`discoverForeignModules`): the foreign workflows its `foreign()` returned,
   * computed once and used everywhere. Its suite counts, its `create` never runs here.
   */
  elsewhere?: AnyWorkflow[]
}

/** A workflow as another process serves it: everything but the body, which refuses to run here. */
export function foreignOf<I extends z.ZodType, O extends z.ZodType>(
  shell: Omit<WorkflowDefinition<I, O>, 'run'>,
): AnyWorkflow {
  return defineWorkflow({
    ...shell,
    run: () => Promise.reject(new Error(`workflow ${shell.id} is served by another process`)),
  })
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

/**
 * The modules of another process's tree that this process starts and scores eval runs of. Each module's `foreign()` is
 * called once and its workflows kept on the module (`elsewhere`), so `buildWorkflows` takes their suites and builds
 * nothing. Fails, naming the file, on a module with a suite and no `foreign()` or no foreign workflow of its id, on a
 * foreign workflow without a scorer, and on an id two modules both serve (naming both files). A module with neither
 * suite nor `foreign()` is the other process's own business and is left out. A missing directory is none.
 */
export async function discoverForeignModules(dir: string): Promise<DiscoveredModule[]> {
  if (!existsSync(dir)) return []
  const modules: DiscoveredModule[] = []
  const served = new Map<string, string>()
  for (const module of await discoverWorkflowModules(dir)) {
    if (!module.foreign) {
      if (module.suite) throw new Error(`workflow modules: ${module.file}: declares a suite but no foreign()`)
      continue
    }
    const workflows = module.foreign()
    if (module.suite && !workflows.some((w) => w.id === module.id))
      throw new Error(`workflow modules: ${module.file}: declares a suite but no foreign workflow "${module.id}"`)
    for (const workflow of workflows) {
      if (!workflow.scorer)
        throw new Error(`workflow modules: ${module.file}: foreign workflow "${workflow.id}" has no scorer`)
      const other = served.get(workflow.id)
      if (other)
        throw new Error(`workflow modules: foreign workflow "${workflow.id}" is served by ${other} and ${module.file}`)
      served.set(workflow.id, module.file)
    }
    modules.push({ ...module, elsewhere: workflows })
  }
  return modules
}

/** The foreign workflows of the `elsewhere` modules, to give the runtime (`RuntimeOptions.foreign`) and `wireEval`. */
export const foreignWorkflows = (modules: readonly DiscoveredModule[]): AnyWorkflow[] =>
  modules.flatMap((m) => m.elsewhere ?? [])

/**
 * Another process's tree for this process, never fatal: a missing directory is a warning and any failure of discovery
 * (an import error anywhere under a module, a bad declaration) an error, each naming the path, and the tree then has no
 * foreign workflow. The eval of that process's suites is lost, not the boot.
 */
export async function loadForeignTree(
  dir: string,
  logger: Logger,
): Promise<{ modules: DiscoveredModule[]; workflows: AnyWorkflow[] }> {
  if (!existsSync(dir)) {
    logger.warn(`foreign workflow modules: ${dir} does not exist; no suites of another process`, { dir })
    return { modules: [], workflows: [] }
  }
  try {
    const modules = await discoverForeignModules(dir)
    return { modules, workflows: foreignWorkflows(modules) }
  } catch (error) {
    logger.error(`foreign workflow modules: ${dir} not loaded; no suites of another process`, {
      dir,
      error: error instanceof Error ? error.message : String(error),
    })
    return { modules: [], workflows: [] }
  }
}

/** The modules' suites, by workflow id. */
export function suitesOf(modules: readonly DiscoveredModule[]): Suites {
  return new Map(modules.flatMap((m) => (m.suite ? [[m.id, m.suite] as const] : [])))
}

/**
 * Builds every module's workflows: `first` phase in order, then `last` with the rest as peers. Fails, naming the file,
 * on a workflow id another module already registered, a suite whose module built workflows but none of its id, or an agent
 * on a route `isRoute` does not know.
 */
export function buildWorkflows(
  modules: readonly DiscoveredModule[],
  deps: HostDeps,
  isRoute: (id: string) => boolean,
): HostWorkflow[] {
  const suites = suitesOf(modules)
  const own = modules.filter((m) => !m.elsewhere)
  // A foreign id a host module is named by is a clash found before anything is built (a workflow of another id is found
  // after, below).
  for (const other of modules.filter((m) => m.elsewhere)) {
    for (const workflow of other.elsewhere ?? []) {
      const host = own.find((m) => m.id === workflow.id)
      if (host)
        throw new Error(`workflow modules: workflow "${workflow.id}" is served by ${other.file} and by ${host.file}`)
    }
  }
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
    // A module that built nothing on this host (no fleet, no database) may still declare its suite: the cases are
    // data, and running them there fails at start, not at boot. One that built other workflows only is a mistake.
    if (module.suite && entries.length > 0 && !entries.some((e) => e.workflow.id === module.id))
      throw new Error(`workflow modules: ${module.file}: declares a suite but serves no workflow "${module.id}"`)
    built.push(...entries)
  }
  for (const module of own.filter((m) => m.phase !== 'last')) add(module, module.create(deps, { suites, peers: [] }))
  const peers = [...built]
  for (const module of own.filter((m) => m.phase === 'last')) add(module, module.create(deps, { suites, peers }))
  for (const other of modules.filter((m) => m.elsewhere)) {
    for (const workflow of other.elsewhere ?? []) {
      const taken = owner.get(workflow.id)
      if (taken)
        throw new Error(`workflow modules: workflow "${workflow.id}" is served by ${other.file} and by ${taken}`)
    }
  }
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
