import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { runawayCap, walletGate } from '@agent-workflows/limits'
import {
  type FingerprintSource,
  type FrictionSource,
  frictionRecounter,
  fsFingerprintSource,
  JournalDb,
  platformMiddleware,
} from '@agent-workflows/middleware'
import { basePolicyDigest, OpenCodeHost, OpenCodeServer } from '@agent-workflows/opencode-host'
import { type AgentHost, type Json, Runtime } from '@agent-workflows/runtime'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { loadAgentDefinitions } from './agents.ts'
import { createHost } from './app.ts'
import { createCapabilityWorkflows } from './capability-runs.ts'
import type { HostConfig } from './config.ts'
import {
  type FrictionStatus,
  frictionStatus,
  type GhPort,
  ghCli as frictionGhCli,
  startFrictionJob,
} from './friction/index.ts'
import { pgLearningsStore, withLearnedFacts, withLearningsFingerprint } from './learnings/index.ts'
import { IDLE_TIMEOUT_S } from './operations.ts'
import { ghCli } from './workflows/retrospective/gh.ts'
import { RETRO_WORKFLOW_ID } from './workflows/retrospective/index.ts'
import { pgJournalReader } from './workflows/retrospective/sample.ts'
import { startRetroSchedule } from './workflows/retrospective/schedule.ts'
import { listTrackedFiles, type TrackedPaths } from './workflows/retrospective/tracked.ts'
import { wireEval } from './workflows/eval/index.ts'
import { createWorkflows, fingerprintWorkflows } from './workflows/index.ts'

const FLUSH_INTERVAL_MS = 30_000
const SHUTDOWN_GRACE_MS = 5000

export interface RunningHost {
  port: number
  /**
   * The friction job's state. `/health` serves `enabled` and `state` only; the reason (which can name a setting) stays
   * in this process and its log.
   */
  friction: FrictionStatus & { reason?: string }
  /** Stop accepting, close the runtime (runs stay `running`), flush telemetry, release pools. Idempotent. */
  shutdown(): Promise<void>
}

export interface BootOptions {
  /** Replaces the OpenCode host (tests). */
  agentHost?: AgentHost
  env?: Record<string, string | undefined>
  /** Replaces the `gh` CLI the friction job opens issues through (tests). */
  gh?: GhPort
}

/**
 * The fingerprint source of the host: each agent's `AGENTS.md`, `agent.json` and skills, its route, the OpenCode
 * version and the host's session policy (`basePolicyDigest`), so a change to any of them moves the fingerprint.
 */
export function hostFingerprintSource(options: {
  agentsDir: string
  workflows: Parameters<typeof fsFingerprintSource>[0]['workflows']
  opencodeBin?: string | undefined
}): FingerprintSource {
  return fsFingerprintSource({ ...options, hostPolicy: basePolicyDigest() })
}

type Exporter = NonNullable<NonNullable<Parameters<typeof platformMiddleware>[0]['telemetry']>['exporter']>

/** Export off without an endpoint: the default exporter would retry `localhost:4318` forever. */
const silentExporter: Exporter = {
  export: (_spans, done) => done({ code: 0 }),
  shutdown: async () => {},
}

function exporterFor(env: Record<string, string | undefined>): Exporter | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  return endpoint ? undefined : silentExporter
}

type AgentDefinitions = ConstructorParameters<typeof OpenCodeHost>[0]['agents']

export type LazyAgentHost = AgentHost & {
  close(): Promise<void>
  /** The counters of every session a step opened. Builds the host if this process has not yet (a run resumed after a restart). */
  stepSessions: FrictionSource['stepSessions']
}

type OpenCodeTraceparent = NonNullable<ConstructorParameters<typeof OpenCodeHost>[0]['traceparent']>

/** What the lazy host needs from a server: `OpenCodeServer`, or a fake in tests. */
export type LazyServer = ConstructorParameters<typeof OpenCodeHost>[0]['server'] & {
  start(): Promise<void>
  close(): Promise<void>
}

export interface LazyOpenCodeOptions {
  /** Where locations and the server's state live. Default: the real state dir. Tests pass a temporary one. */
  stateDir?: string
  /** Builds the server on the first step. Default: a real `OpenCodeServer` on `stateDir`. */
  createServer?: () => LazyServer
  /** `close` waits this long for a start still in flight, then closes what exists. Default 5 s. */
  closeWaitMs?: number
  /** The agents the host serves (`agents/<name>/`). Default: none. */
  agents?: AgentDefinitions
}

/**
 * The OpenCode `AgentHost`, built on the first agent step: the server (and the host's maintenance timer) does not
 * exist at boot, so a host without agent workflows never spawns or probes `opencode`. A failed start is not cached,
 * so the next step retries. `close` stops supervising; the server keeps running for the next process (a deploy).
 */
export function lazyOpenCodeHost(
  env: Record<string, string | undefined>,
  traceparent: OpenCodeTraceparent,
  options: LazyOpenCodeOptions = {},
): LazyAgentHost {
  const { stateDir, closeWaitMs = 5000, agents = [] } = options
  const createServer = options.createServer ?? (() => new OpenCodeServer({ env, stateDir }))
  let built: Promise<{ server: LazyServer; host: OpenCodeHost }> | undefined
  let closed = false
  const get = () => {
    if (closed) return Promise.reject(new Error('opencode host is closed'))
    built ??= (async () => {
      const server = createServer()
      await server.start()
      if (closed) {
        // close() gave up waiting for this start; nothing else will ever stop supervising it.
        await server.close()
        throw new Error('opencode host is closed')
      }
      return { server, host: new OpenCodeHost({ server, agents, env, traceparent, stateDir }) }
    })().catch((error: unknown) => {
      built = undefined
      throw error
    })
    return built
  }
  return {
    open: async (spec) => (await get()).host.open(spec),
    prompt: async (handle: Json, prompt) => (await get()).host.prompt(handle, prompt),
    wait: async (handle: Json, options) => (await get()).host.wait(handle, options),
    steer: async (handle: Json, text, options) => (await get()).host.steer(handle, text, options),
    abort: async (handle: Json) => (await get()).host.abort(handle),
    followUp: async (handle: Json, spec) => (await get()).host.followUp(handle, spec),
    // Builds on demand: a run resumed after a restart has finished agent steps whose sessions this process never touched.
    // Only asked for runs that have agent steps, so a host without agent workflows still never spawns `opencode`.
    stepSessions: async (step) => (await get()).host.stepFriction(step),
    async close() {
      closed = true
      if (!built) return
      const timeout = Bun.sleep(closeWaitMs).then(() => undefined)
      const ready = await Promise.race([built.catch(() => undefined), timeout])
      ready?.host.close()
      await ready?.server.close()
    },
  }
}

export async function boot(config: HostConfig, options: BootOptions = {}): Promise<RunningHost> {
  const env = options.env ?? process.env

  // Every resource registers its closer as it is created; a failure at any point runs the same teardown as a
  // signal does, in reverse order, so a half-started process never keeps pools, timers or leases.
  const closers: (() => Promise<void>)[] = []
  let closing: Promise<void> | undefined
  const shutdown = () =>
    (closing ??= (async () => {
      const failures: unknown[] = []
      for (const close of closers.toReversed()) {
        await close().catch((error: unknown) => {
          failures.push(error)
          console.error('[agw-host] close failed:', error instanceof Error ? error.message : error)
        })
      }
      if (failures.length > 0) throw failures[0]
    })())

  try {
    const registry = createRegistry(createCapabilities())
    // The learnings store and the retrospective's journal reads share one small pool of the host's own.
    const readPool = new Pool({
      connectionString: config.pgUrl,
      max: 2,
      application_name: `agw-host:${config.schema}`,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    })
    readPool.on('error', (err) => console.warn('[agw-host] read pool: idle connection error', err.message))
    closers.push(() => readPool.end())
    const learnings = pgLearningsStore(readPool, config.schema)
    const journal = pgJournalReader(readPool, config.schema)
    const gh = config.retroFileIssues && config.retroIssueRepo ? ghCli({ repo: config.retroIssueRepo }) : undefined
    // Issues may name only paths this repo tracks; a release is a `git archive` of the commit (see tracked.ts).
    const repoRoot = resolve(import.meta.dir, '../../..')
    let trackedList: Promise<TrackedPaths> | undefined
    const tracked = () =>
      (trackedList ??= listTrackedFiles(repoRoot).catch((error: unknown) => {
        trackedList = undefined // a failed read is retried, never cached
        throw error
      }))
    const workflows = createWorkflows({ registry, retro: { journal, learnings, gh, tracked } })
    // Direct capability calls over HTTP run as `cap.<id>` workflows (concept N6): registered, but not operations.
    const capabilityWorkflows = createCapabilityWorkflows(registry)
    const agentsDir = config.agentsDir ?? 'agents'
    const agents = loadAgentDefinitions(agentsDir)

    // The platform is built before the agent host (the host needs its traceparent); the counters source binds late.
    let owned: LazyAgentHost | undefined
    const frictionSource: FrictionSource = {
      stepSessions: async (step) => (await owned?.stepSessions(step)) ?? { sessions: [], incomplete: false },
    }
    const frictionState = frictionStatus(config.friction)
    if (config.friction && frictionState.state !== 'on') {
      console.warn(`[agw-host] friction job ${frictionState.state}: ${frictionState.reason ?? 'no reason given'}`)
    }
    const platform = platformMiddleware({
      connectionString: config.pgUrl,
      schema: config.schema,
      // The active learnings of each agent enter the fingerprint beside its AGENTS.md and skills (concept §5).
      fingerprint: withLearningsFingerprint(
        hostFingerprintSource({
          agentsDir,
          workflows: fingerprintWorkflows(workflows),
          opencodeBin: config.opencodeBin,
        }),
        learnings,
      ),
      iuKey: config.iuKey,
      friction: frictionSource,
      telemetry: { exporter: exporterFor(env) },
      argo: { machine: config.machine },
    })
    closers.push(() => platform.close())
    owned = options.agentHost
      ? undefined
      : lazyOpenCodeHost(env, (runId, stepId) => platform.telemetry.traceparent(runId, stepId) ?? undefined, {
          agents,
        })
    const agentHost = options.agentHost ?? owned
    const lazy = owned
    if (lazy) closers.push(() => lazy.close())
    const cap = runawayCap({ connectionString: config.pgUrl, schema: config.schema })
    closers.push(() => cap.close())
    // Optional expensive work (OCR) is its own workflow, refused at admission by the wallet gate (concept §4).
    const wallet = walletGate({
      workflows: workflows.filter((entry) => entry.optionalExpensive).map((entry) => entry.workflow.id),
    })
    const runtime = new Runtime({
      connectionString: config.pgUrl,
      schema: config.schema,
      workflows: [...workflows.map((entry) => entry.workflow), ...capabilityWorkflows.values()],
      host: agentHost,
      // Active learned facts follow the task message, never AGENTS.md, whose prefix stays cacheable.
      agentPrompt: async ({ agent, prompt }) => withLearnedFacts(prompt, await learnings.activeFor(agent)),
      middleware: [...platform.middleware, wallet, cap],
    })
    closers.push(() => runtime.close())
    // Eval runs reach the runtime before it opens (recovery may resume one); drift scores sampled production runs.
    const evalJobs = wireEval({ runtime, workflows, env })
    closers.push(() => evalJobs.close())

    // The journal reads behind the HTTP bodies go through the runtime's own pool (`runtime.getRun`): a poll is one
    // indexed primary-key read, backed off to 250 ms, so held waits cost the journal far less than the run writes.
    let open = false
    const host = createHost({
      runtime,
      registry,
      workflows,
      capabilityWorkflows,
      secret: config.secret,
      version: config.version,
      isOpen: () => open,
      friction: { enabled: frictionState.enabled, state: frictionState.state },
    })
    await host.openapi() // a broken contract fails the start, not the first request

    // Bind before the runtime opens: a taken port (a deploy overlap) must fail before any run is claimed.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: host.fetch,
    })
    closers.push(async () => {
      // Stop accepting; give held `Prefer: wait` requests a moment to answer, then cut them (the CLI resumes).
      const draining = server.stop().catch((error: unknown) => {
        console.error('[agw-host] graceful stop failed:', error instanceof Error ? error.message : error)
      })
      await Promise.race([draining, Bun.sleep(SHUTDOWN_GRACE_MS)])
      await server.stop(true)
    })

    await runtime.open()
    open = true
    evalJobs.start()
    closers.push(async () => {
      open = false
    })

    const retrospective = workflows.find((entry) => entry.workflow.id === RETRO_WORKFLOW_ID)
    if (config.retroWeekly && retrospective) {
      const schedule = startRetroSchedule({
        runtime,
        retrospective,
        journal,
        workflows: workflows
          .filter((entry) => entry.agents?.length && entry !== retrospective)
          .map((entry) => entry.workflow.id),
        fileIssues: config.retroFileIssues,
        logger: {
          warn: (message, meta) => console.warn(`[agw-host] ${message}`, meta ?? ''),
          error: (message, meta) => console.error(`[agw-host] ${message}`, meta ?? ''),
        },
      })
      closers.push(() => schedule.stop())
    }

    if (config.friction?.enabled) {
      const frictionDb = new JournalDb({ connectionString: config.pgUrl, schema: config.schema, poolSize: 1 }, console)
      const recounter = frictionRecounter({
        db: frictionDb,
        logger: {
          warn: (m, meta) => console.warn(`[agw-host] ${m}`, meta ?? ''),
          error: (m, meta) => console.error(`[agw-host] ${m}`, meta ?? ''),
        },
        source: frictionSource,
      })
      const job = startFrictionJob({
        db: frictionDb,
        recount: (runId, recountOptions) => recounter.recount(runId, recountOptions),
        settings: config.friction,
        gh: options.gh ?? frictionGhCli,
        logger: {
          warn: (m, meta) => console.warn(`[agw-host] ${m}`, meta ?? ''),
          error: (m, meta) => console.error(`[agw-host] ${m}`, meta ?? ''),
        },
      })
      closers.push(async () => {
        await job.close() // aborts the job's calls, waits a bounded time
        // An in-flight query ends at its own timeout; the pool close is capped, and its timer cleared when it is not.
        let cap: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            frictionDb.close(),
            new Promise<void>((resolve) => {
              cap = setTimeout(resolve, 2000)
            }),
          ])
        } finally {
          clearTimeout(cap)
        }
      })
    }

    let flushing = false
    const flushTimer = setInterval(() => {
      if (flushing || !platform.outbox) return
      flushing = true
      platform.outbox
        .flush()
        .catch((err: unknown) =>
          console.error('[agw-host] outbox flush failed', err instanceof Error ? err.message : err),
        )
        .finally(() => {
          flushing = false
        })
    }, FLUSH_INTERVAL_MS)
    closers.push(async () => clearInterval(flushTimer))

    return { port: server.port ?? config.port, friction: frictionState, shutdown }
  } catch (error) {
    await shutdown().catch(() => {}) // already logged by the closer
    throw error
  }
}
