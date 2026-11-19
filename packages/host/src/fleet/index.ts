import type { Logger } from '@agent-workflows/runtime'
import { emptySnapshot, mapFleet } from './derive.ts'
import { commandRunner, type FactoryRead, type FleetConfig, fleetConfig, readFactoryFleet } from './factory.ts'
import { enrichmentOf, mergeOverviewIntoSnapshot, parseStoredOverview } from './overview.ts'
import { claudeAccountCli, createQuota, type Quota } from './quota.ts'
import { type AgentEnrichment, parseCols, renderText } from './render.ts'
import type { AccountQuota, OverviewOutput, OverviewPayload, Snapshot } from './schema.ts'

export { type ClassifyInput, classifyInput, reconcileKnown } from './overview.ts'
export type { Quota } from './quota.ts'

/**
 * The snapshot cache: a herdr pane and Hermes read within seconds of each other, and one snapshot
 * is one factory read (two `factory read` calls). Consumers poll about every 31 s (measured on the legacy gateway: 20 s missed the window
 * on nearly every request), so 45 s shares one build. The promise is cached,
 * so concurrent first callers share one build.
 */
const SNAPSHOT_CACHE_MS = 45_000

export interface FleetDeps {
  /** One read of the factory's /v1 read API (production: `factory read overview` and `factory read sessions --live`); a failure is a value, never a throw. */
  factory: () => Promise<FactoryRead>
  quota: Quota
  /** The newest completed `overview` run's output, or null when none exists. */
  latestOverview: () => Promise<unknown>
  config: Pick<FleetConfig, 'staleAfterHours'>
  now?: () => number
}

/** A snapshot and whether the factory was read: a failed read is an empty snapshot with one warning, never a fleet. */
export type SnapshotRead = { snapshot: Snapshot; unreadable: string | null }

export interface MergedView {
  snapshot: Snapshot
  /** The warning of a failed factory read, else null: the classify step must not act on it. */
  unreadable: string | null
  accounts: Record<string, AccountQuota>
  payload: OverviewPayload
  enrichment: Map<string, AgentEnrichment>
}

export interface Fleet {
  /** The deterministic snapshot; cached for 45 s unless `fresh` (the classify run wants what is true now). */
  snapshot(options?: { fresh?: boolean; staleAfterHours?: number }): Promise<Snapshot>
  /** {@link Fleet.snapshot} with the outcome of the factory read: the callers that act on the fleet need to tell empty from unreadable. */
  read(options?: { fresh?: boolean; staleAfterHours?: number }): Promise<SnapshotRead>
  /** The snapshot, merged with the newest overview run and the quota: `agw agents`' data. */
  view(options?: { overview?: OverviewOutput }): Promise<MergedView>
  quota: Quota
}

export function createFleet(deps: FleetDeps): Fleet {
  const now = deps.now ?? Date.now
  let cached: { at: number; promise: Promise<SnapshotRead> } | null = null

  /** The read, mapped. The clock is taken after the read unless the caller sets one (the cache): no activity is newer than the snapshot. */
  const build = async (staleAfterHours: number, at?: number): Promise<SnapshotRead> => {
    const read = await deps.factory()
    const time = at ?? Date.now()
    if (!read.ok) {
      return {
        snapshot: emptySnapshot({ now: time, staleAfterHours, warning: read.warning }),
        unreadable: read.warning,
      }
    }
    return { snapshot: mapFleet(read.fleet, { now: time, staleAfterHours }), unreadable: null }
  }

  const read: Fleet['read'] = (options = {}) => {
    const hours = options.staleAfterHours ?? deps.config.staleAfterHours
    if (options.fresh || options.staleAfterHours !== undefined) return build(hours)
    const at = now()
    if (cached && at - cached.at < SNAPSHOT_CACHE_MS) return cached.promise
    const promise = build(hours, at)
    cached = { at, promise }
    // A failed read is not served from the cache: the next caller asks the factory again.
    void promise.then(
      (built) => {
        if (built.unreadable !== null && cached?.promise === promise) cached = null
      },
      () => {
        if (cached?.promise === promise) cached = null
      },
    )
    return promise
  }
  const snapshot: Fleet['snapshot'] = async (options) => (await read(options)).snapshot

  return {
    snapshot,
    read,
    quota: deps.quota,
    async view(options = {}) {
      const [{ snapshot: snap, unreadable }, accounts, picks, stored] = await Promise.all([
        read(),
        deps.quota.accounts(),
        deps.quota.picks(),
        options.overview ? null : deps.latestOverview(),
      ])
      const merged = mergeOverviewIntoSnapshot(snap, options.overview ?? parseStoredOverview(stored))
      return {
        snapshot: snap,
        unreadable,
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
  latestOverview: () => Promise<unknown>
}

/** The production fleet of the host process. */
export function hostFleet(options: HostFleetOptions) {
  const config = fleetConfig(options.env)
  const warn = (message: string, meta?: Record<string, unknown>) => options.logger.warn(message, meta)
  const run = commandRunner(options.env)
  const fleet = createFleet({
    factory: () => readFactoryFleet(run, config, options.env),
    quota: createQuota({ cli: claudeAccountCli({ env: options.env }), warn: (message) => warn(message) }),
    latestOverview: options.latestOverview,
    config,
  })
  return { fleet, config }
}
