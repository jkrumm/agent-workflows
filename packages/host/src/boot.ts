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
import { basePolicyDigest, DEFAULT_STATE_DIR, OpenCodeHost, OpenCodeServer } from '@agent-workflows/opencode-host'
import { validateOverrides } from '@agent-workflows/routes'
import { type AgentHost, type Json, type Logger, Runtime } from '@agent-workflows/runtime'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { loadAgentDefinitions } from './agents.ts'
import { createHost } from './app.ts'
import { createCapabilityWorkflows } from './capability-runs.ts'
import type { HostConfig, ProcessConfig } from './config.ts'
import {
  type FrictionSettings,
  type FrictionStatus,
  frictionStatus,
  type GhPort,
  ghCli as frictionGhCli,
  startFrictionJob,
} from './friction/index.ts'
import { type LearningsStore, pgLearningsStore, withLearnedFacts, withLearningsFingerprint } from './learnings/index.ts'
import { type HostWorkflow, IDLE_TIMEOUT_S } from './operations.ts'
import { ghCli } from './workflows/retrospective/gh.ts'
import { RETRO_WORKFLOW_ID } from './workflows/retrospective/index.ts'
import { pgJournalReader } from './workflows/retrospective/sample.ts'
import { startRetroSchedule } from './workflows/retrospective/schedule.ts'
import { listTrackedFiles, type TrackedPaths } from './workflows/retrospective/tracked.ts'
import { scorerJudge } from './judge.ts'
import { type CapabilityCall, ToolGate } from './tool-gate/index.ts'
import { pgToolLedger } from './workflows/research/ledger.ts'
import { wireEval } from './workflows/eval/index.ts'
import { createWorkflows, fingerprintWorkflows, type HostRegistry } from './workflows/index.ts'

const FLUSH_INTERVAL_MS = 30_000
const SHUTDOWN_GRACE_MS = 5000

/** A process's logger: its console, every line tagged `[agw-<name>]`. */
export function processLogger(name: string): Logger {
  return {
    warn: (message, meta) => console.warn(`[agw-${name}] ${message}`, meta ?? ''),
    error: (message, meta) => console.error(`[agw-${name}] ${message}`, meta ?? ''),
  }
}

export interface RunningHost {
  port: number
  /** The bound ports of the definition's `doorOnly` listeners, in declaration order. */
  doorOnlyPorts: number[]
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
  /**
   * Where the OpenCode server, the agents' locations and the tool gate's `gate.json` live; they must agree (the plugins
   * find the gate relative to their location). Default: the process definition's, else the OpenCode host's state dir.
   * Two processes never share one: two tool gates would overwrite each other's `gate.json`.
   */
  stateDir?: string
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

/** What a process definition builds its workflows from: the pieces every platform process shares. */
export interface ProcessBase {
  config: ProcessConfig
  env: Record<string, string | undefined>
  logger: Logger
  /** Every capability, for in-process calls from a workflow's steps (served over HTTP only by `serveCapabilities`). */
  registry: HostRegistry
  /** The process's one tool gate, on its own state dir. */
  toolGate: ToolGate
  /** A small pool of the process's own for journal reads (the learnings store, the retrospective). */
  readPool: Pool
  learnings: LearningsStore
  /** Registers a closer; every closer runs on shutdown (or a failed start) in reverse order. */
  onClose: (close: () => Promise<void>) => void
}

/** What a process's jobs and extra routes see once the runtime exists. */
export interface ProcessRuntime extends ProcessBase {
  runtime: Runtime
  workflows: readonly HostWorkflow[]
  /** True from `runtime.open()` until shutdown begins. */
  isOpen: () => boolean
}

/**
 * A route served beside the API, ahead of its bearer check: it owns its auth. Answers its requests, `undefined` for
 * the rest (they reach the API).
 */
export type ProcessRoute = (request: Request, url: URL) => Promise<Response> | undefined

/**
 * A second loopback listener that serves only the routes given and answers 404 with no body for everything else:
 * `/health`, `/openapi.json` and the whole API are not reachable on it. For callers that reach the process through a
 * forwarded port (a `tailscale serve` row) and must see one surface, not the process's.
 */
export interface DoorOnlyListener {
  /** 0 binds a free port (tests). A taken port refuses the start, like the main listener. */
  port: number
  /** Built before the listener binds; the routes own their auth, as on the main listener. */
  routes(process: ProcessRuntime): ProcessRoute[]
}

/**
 * One platform process (concept §8): its name, its workflows, and what it adds to the shared core. The core is the
 * same for every process: the journal and the platform middleware (run record, fingerprint, telemetry, Argo outbox),
 * the runaway cap and the wallet gate, the bearer-authenticated API with its OpenAPI and `x-cli`, `/health` with the
 * version, and the OpenCode agent host built lazily on the first agent step.
 */
export interface ProcessDefinition {
  /** `host`, `audio`: the log tag (`[agw-<name>]`) and the pools' application names. */
  name: string
  /** Telemetry's `service.name`. */
  serviceName: string
  /** The state dir of the tool gate and the agent host (see `BootOptions.stateDir`). */
  stateDir?: string
  /**
   * Serve the capabilities over HTTP (`agw llm title …`) as `cap.<id>` runs. Exactly one process does: the CLI refuses a
   * command two processes declare. The others still call every capability in-process.
   */
  serveCapabilities: boolean
  /** The daily friction job: `/health` reports its state, `settings` (absent: off) start it. Only the host runs one. */
  friction?: { settings: FrictionSettings | undefined }
  workflows(base: ProcessBase): Promise<HostWorkflow[]>
  /** Wired before the runtime opens (recovery may resume a run that needs them); `start` runs once it is open. */
  jobs?(process: ProcessRuntime): { start(): void } | undefined
  /** Built before the server binds. */
  routes?(process: ProcessRuntime): ProcessRoute[]
  /** Extra listeners that serve only their own routes (see `DoorOnlyListener`), bound with the main one. */
  doorOnly?: DoorOnlyListener[]
}

const NOT_FOUND = () => new Response(null, { status: 404 })

export async function bootProcess(
  definition: ProcessDefinition,
  config: ProcessConfig,
  options: BootOptions = {},
): Promise<RunningHost> {
  const env = options.env ?? process.env
  const { name } = definition
  const logger = processLogger(name)
  const tag = `[agw-${name}]`
  // `AGW_ROUTES` is otherwise read at first use (a run's fingerprint, a model call, the first agent session), so a typo
  // would surface as a failed run. Validating it here refuses the start instead, before anything is opened; the error
  // names the route id and the problem, never the override JSON.
  validateOverrides(env)

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
          console.error(`${tag} close failed:`, error instanceof Error ? error.message : error)
        })
      }
      if (failures.length > 0) throw failures[0]
    })())

  try {
    const registry = createRegistry(createCapabilities())
    // The learnings store and the retrospective's journal reads share one small pool of the process's own.
    const readPool = new Pool({
      connectionString: config.pgUrl,
      max: 2,
      application_name: `agw-${name}:${config.schema}`,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    })
    readPool.on('error', (err) => console.warn(`${tag} read pool: idle connection error`, err.message))
    closers.push(() => readPool.end())
    const learnings = pgLearningsStore(readPool, config.schema)
    // One tool gate per process: every workflow that gives an agent tools opens its grants on it.
    const stateDir = options.stateDir ?? definition.stateDir ?? DEFAULT_STATE_DIR
    const gateCalls = registry as unknown as { call: CapabilityCall }
    const toolGate = new ToolGate({
      stateDir,
      call: (id, input, scope) => gateCalls.call(id, input, scope),
      logger,
    })
    closers.push(() => toolGate.close())
    const base: ProcessBase = {
      config,
      env,
      logger,
      registry,
      toolGate,
      readPool,
      learnings,
      onClose: (close) => closers.push(close),
    }
    const workflows = await definition.workflows(base)
    // Direct capability calls over HTTP run as `cap.<id>` workflows (concept N6): registered, but not operations.
    const capabilityWorkflows = definition.serveCapabilities
      ? createCapabilityWorkflows(registry)
      : new Map<string, never>()
    const agentsDir = config.agentsDir ?? 'agents'
    const agents = loadAgentDefinitions(agentsDir)

    // The platform is built before the agent host (the host needs its traceparent); the counters source binds late.
    let owned: LazyAgentHost | undefined
    const frictionSource: FrictionSource = {
      stepSessions: async (step) => (await owned?.stepSessions(step)) ?? { sessions: [], incomplete: false },
    }
    const frictionSettings = definition.friction?.settings
    const frictionState = frictionStatus(frictionSettings)
    if (frictionSettings && frictionState.state !== 'on') {
      console.warn(`${tag} friction job ${frictionState.state}: ${frictionState.reason ?? 'no reason given'}`)
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
      telemetry: { exporter: exporterFor(env), serviceName: definition.serviceName },
      argo: { machine: config.machine },
    })
    closers.push(() => platform.close())
    owned = options.agentHost
      ? undefined
      : lazyOpenCodeHost(env, (runId, stepId) => platform.telemetry.traceparent(runId, stepId) ?? undefined, {
          agents,
          stateDir,
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
    // Recovery, leases, post-hook redelivery and drift sampling only ever touch runs of the workflows given here
    // (`Journal.claimable`, `postHooksPending`, `driftCandidates` filter by them): processes on one journal never take
    // over each other's runs, and a run whose process is down waits for it.
    const runtime = new Runtime({
      connectionString: config.pgUrl,
      schema: config.schema,
      workflows: [...workflows.map((entry) => entry.workflow), ...capabilityWorkflows.values()],
      host: agentHost,
      // Active learned facts follow the task message, never AGENTS.md, whose prefix stays cacheable.
      agentPrompt: async ({ agent, prompt }) => withLearnedFacts(prompt, await learnings.activeFor(agent)),
      middleware: [...platform.middleware, wallet, cap],
      // A scorer's judged sub-scores (research: `web.fetch` + `decide`, `web.package`): allowlisted capabilities, each
      // call a recorded `cap.*` run with purpose eval or drift (judge.ts). Review and check never judge.
      judge: scorerJudge({ registry, workflows: capabilityWorkflows, runtime: () => runtime }),
    })
    closers.push(() => runtime.close())

    let open = false
    const processRuntime: ProcessRuntime = { ...base, runtime, workflows, isOpen: () => open }
    const jobs = definition.jobs?.(processRuntime)

    // The journal reads behind the HTTP bodies go through the runtime's own pool (`runtime.getRun`): a poll is one
    // indexed primary-key read, backed off to 250 ms, so held waits cost the journal far less than the run writes.
    const host = createHost({
      runtime,
      registry: definition.serveCapabilities
        ? registry
        : { capabilities: [], router: {}, requestContext: registry.requestContext },
      workflows,
      capabilityWorkflows,
      secret: config.secret,
      version: config.version,
      isOpen: () => open,
      logger,
      ...(definition.friction ? { friction: { enabled: frictionState.enabled, state: frictionState.state } } : {}),
    })
    await host.openapi() // a broken contract fails the start, not the first request
    const routes = definition.routes?.(processRuntime) ?? []
    const serve = async (request: Request): Promise<Response> => {
      if (routes.length > 0) {
        const url = new URL(request.url)
        for (const route of routes) {
          const answer = route(request, url)
          if (answer) return answer
        }
      }
      return host.fetch(request)
    }

    // Bind before the runtime opens: a taken port (a deploy overlap) must fail before any run is claimed.
    const servers: ReturnType<typeof Bun.serve>[] = []
    closers.push(async () => {
      // Stop accepting; give held `Prefer: wait` requests a moment to answer, then cut them (the CLI resumes). Every
      // listener drains at once, so the grace is one wait, not one per listener.
      await Promise.all(
        servers.map(async (server) => {
          const draining = server.stop().catch((error: unknown) => {
            console.error(`${tag} graceful stop failed:`, error instanceof Error ? error.message : error)
          })
          await Promise.race([draining, Bun.sleep(SHUTDOWN_GRACE_MS)])
          await server.stop(true)
        }),
      )
    })
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: serve,
    })
    servers.push(server)
    const doorOnlyPorts: number[] = []
    for (const listener of definition.doorOnly ?? []) {
      const doorRoutes = listener.routes(processRuntime)
      const doorServer = Bun.serve({
        hostname: '127.0.0.1',
        port: listener.port,
        idleTimeout: IDLE_TIMEOUT_S,
        fetch: (request) => {
          const url = new URL(request.url)
          for (const route of doorRoutes) {
            const answer = route(request, url)
            if (answer) return answer
          }
          return NOT_FOUND()
        },
      })
      servers.push(doorServer)
      doorOnlyPorts.push(doorServer.port ?? listener.port)
    }

    await runtime.open()
    open = true
    // Pushed before the jobs start, so their closers (the retrospective schedule) run before `open` turns false.
    closers.push(async () => {
      open = false
    })
    jobs?.start()

    if (frictionSettings?.enabled) {
      const frictionDb = new JournalDb({ connectionString: config.pgUrl, schema: config.schema, poolSize: 1 }, console)
      const recounter = frictionRecounter({ db: frictionDb, logger, source: frictionSource })
      const job = startFrictionJob({
        db: frictionDb,
        recount: (runId, recountOptions) => recounter.recount(runId, recountOptions),
        settings: frictionSettings,
        gh: options.gh ?? frictionGhCli,
        logger,
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

    // The outbox claims its rows (`for update skip locked`, a claim token), so processes flushing one journal post
    // every row once between them (middleware `outbox.test.ts`).
    let flushing = false
    const flushTimer = setInterval(() => {
      if (flushing || !platform.outbox) return
      flushing = true
      platform.outbox
        .flush()
        .catch((err: unknown) => console.error(`${tag} outbox flush failed`, err instanceof Error ? err.message : err))
        .finally(() => {
          flushing = false
        })
    }, FLUSH_INTERVAL_MS)
    closers.push(async () => clearInterval(flushTimer))

    return { port: server.port ?? config.port, doorOnlyPorts, friction: frictionState, shutdown }
  } catch (error) {
    await shutdown().catch(() => {}) // already logged by the closer
    throw error
  }
}

/** The host process: every workflow under `src/workflows`, the capabilities over HTTP, the retrospective, eval and friction. */
export function hostProcess(config: HostConfig): ProcessDefinition {
  let journal: ReturnType<typeof pgJournalReader> | undefined
  return {
    name: 'host',
    serviceName: 'agw',
    serveCapabilities: true,
    friction: { settings: config.friction },
    async workflows({ config: base, registry, toolGate, logger, readPool, learnings, onClose }) {
      journal = pgJournalReader(readPool, base.schema)
      const gh = config.retroFileIssues && config.retroIssueRepo ? ghCli({ repo: config.retroIssueRepo }) : undefined
      // Issues may name only paths this repo tracks; a release is a `git archive` of the commit (see tracked.ts).
      const repoRoot = resolve(import.meta.dir, '../../..')
      let trackedList: Promise<TrackedPaths> | undefined
      const tracked = () =>
        (trackedList ??= listTrackedFiles(repoRoot).catch((error: unknown) => {
          trackedList = undefined // a failed read is retried, never cached
          throw error
        }))
      // The research tool gate's evidence writes: their own pool, so parallel tool calls never queue behind journal reads.
      const ledgerPool = new Pool({
        connectionString: base.pgUrl,
        max: 4,
        application_name: `agw-host:${base.schema}:research-ledger`,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      })
      ledgerPool.on('error', (err) =>
        console.warn('[agw-host] research ledger pool: idle connection error', err.message),
      )
      onClose(() => ledgerPool.end())
      return createWorkflows({
        registry,
        toolGate,
        logger,
        retro: { journal, learnings, gh, tracked },
        research: { ledger: pgToolLedger(ledgerPool, base.schema) },
      })
    },
    jobs({ runtime, workflows, env, onClose, logger }) {
      // Eval runs reach the runtime before it opens (recovery may resume one); drift scores sampled production runs.
      const evalJobs = wireEval({ runtime, workflows: [...workflows], env })
      onClose(() => evalJobs.close())
      return {
        start() {
          evalJobs.start()
          const retrospective = workflows.find((entry) => entry.workflow.id === RETRO_WORKFLOW_ID)
          if (!config.retroWeekly || !retrospective || !journal) return
          const schedule = startRetroSchedule({
            runtime,
            retrospective,
            journal,
            workflows: workflows
              .filter((entry) => entry.agents?.length && entry !== retrospective)
              .map((entry) => entry.workflow.id),
            fileIssues: config.retroFileIssues,
            logger,
          })
          onClose(() => schedule.stop())
        },
      }
    },
  }
}

export function boot(config: HostConfig, options: BootOptions = {}): Promise<RunningHost> {
  return bootProcess(hostProcess(config), config, options)
}
