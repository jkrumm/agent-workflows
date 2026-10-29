import type { Logger } from '@agent-workflows/runtime'
import { createArgoPush } from './argo.ts'
import {
  buildSnapshot,
  type Collectors,
  commandRunner,
  defaultCollectors,
  type FleetConfig,
  fleetConfig,
} from './collect.ts'
import { enrichmentOf, mergeOverviewIntoSnapshot, parseStoredOverview } from './overview.ts'
import { claudeAccountCli, createQuota, type Quota } from './quota.ts'
import { type AgentEnrichment, parseCols, renderText } from './render.ts'
import type { AccountQuota, OverviewOutput, OverviewPayload, Snapshot } from './schema.ts'

export { agentIds, buildAgentFacts, reconcileOverview } from './overview.ts'
export { startArgoSchedule } from './argo.ts'
export { fleetConfig } from './collect.ts'
export type { ArgoPush } from './argo.ts'
export type { Quota } from './quota.ts'

/**
 * The snapshot cache: a herdr pane, Hermes and the Argo push all read within seconds of each other, and one snapshot
 * costs three CLI calls, a transcript tail per agent and a git status per project. Consumers poll about every 31 s
 * (measured on the legacy gateway: 20 s missed the window on nearly every request), so 45 s shares one build and still
 * stays under the ten-minute push. The promise is cached, so concurrent first callers share one build.
 */
const SNAPSHOT_CACHE_MS = 45_000

export interface FleetDeps {
  collectors: Collectors
  quota: Quota
  /** The newest completed `overview` run's output, or null when none exists. */
  latestOverview: () => Promise<unknown>
  config: Pick<FleetConfig, 'staleAfterHours'>
  now?: () => number
}

export interface MergedView {
  snapshot: Snapshot
  accounts: Record<string, AccountQuota>
  payload: OverviewPayload
  enrichment: Map<string, AgentEnrichment>
}

export interface Fleet {
  /** The deterministic snapshot; cached for 45 s unless `fresh` (the classify run wants what is true now). */
  snapshot(options?: { fresh?: boolean; staleAfterHours?: number }): Promise<Snapshot>
  /** The snapshot, merged with the newest overview run and the quota: `agw agents`' data and the Argo body. */
  view(options?: { overview?: OverviewOutput }): Promise<MergedView>
  quota: Quota
}

export function createFleet(deps: FleetDeps): Fleet {
  const now = deps.now ?? Date.now
  let cached: { at: number; promise: Promise<Snapshot> } | null = null

  const snapshot: Fleet['snapshot'] = (options = {}) => {
    const hours = options.staleAfterHours ?? deps.config.staleAfterHours
    if (options.fresh || options.staleAfterHours !== undefined)
      return buildSnapshot(deps.collectors, { staleAfterHours: hours })
    const at = now()
    if (cached && at - cached.at < SNAPSHOT_CACHE_MS) return cached.promise
    const promise = buildSnapshot(deps.collectors, { now: at, staleAfterHours: hours })
    cached = { at, promise }
    // A failed build is not served from the cache: the next caller rebuilds.
    promise.catch(() => {
      if (cached?.promise === promise) cached = null
    })
    return promise
  }

  return {
    snapshot,
    quota: deps.quota,
    async view(options = {}) {
      const [snap, accounts, picks, stored] = await Promise.all([
        snapshot(),
        deps.quota.accounts(),
        deps.quota.picks(),
        options.overview ? null : deps.latestOverview(),
      ])
      const merged = mergeOverviewIntoSnapshot(snap, options.overview ?? parseStoredOverview(stored))
      return {
        snapshot: snap,
        accounts,
        enrichment: enrichmentOf(merged),
        payload: { ...snap, projects: merged.projects, overview: merged.overview, quota: { accounts, picks } },
      }
    },
  }
}

/** The text render of the merged view, as `agw agents --text` prints it. */
export async function renderView(fleet: Fleet, options: { color?: boolean; cols?: number }): Promise<string> {
  const { snapshot, payload, accounts, enrichment } = await fleet.view()
  return renderText(snapshot, {
    enrichment,
    overview: payload.overview,
    quota: accounts,
    color: options.color === true,
    cols: parseCols(options.cols),
  })
}

export interface HostFleetOptions {
  env: Record<string, string | undefined>
  logger: Logger
  machine: string
  latestOverview: () => Promise<unknown>
}

/** The production fleet of the host process plus its Argo push (the push is off without `ARGO_URL` and `ARGO_API_SECRET`). */
export function hostFleet(options: HostFleetOptions) {
  const config = fleetConfig(options.env)
  const warn = (message: string, meta?: Record<string, unknown>) => options.logger.warn(message, meta)
  const fleet = createFleet({
    collectors: defaultCollectors(config, commandRunner(options.env), { warn }),
    quota: createQuota({ cli: claudeAccountCli({ env: options.env }), warn: (message) => warn(message) }),
    latestOverview: options.latestOverview,
    config,
  })
  const argo = createArgoPush({
    url: options.env.ARGO_URL,
    secret: options.env.ARGO_API_SECRET,
    machine: options.machine,
    build: async (overview) => (await fleet.view(overview ? { overview } : {})).payload,
    // The runtime's logger has no info level; an outcome that went well is still one line (a quiet fleet is a fact).
    logger: { warn, info: (message, meta) => console.log(`[agw-host] ${message}`, meta ?? '') },
  })
  return { fleet, argo, config }
}

/** `AGW_ARGO_PUSH=0|off|false|no` turns the ten-minute timer off (tests); on by default. */
export function argoTimerEnabled(env: Record<string, string | undefined>): boolean {
  return !['0', 'off', 'false', 'no'].includes(env.AGW_ARGO_PUSH?.trim().toLowerCase() ?? '')
}
