import { join } from 'node:path'
import {
  type BootOptions,
  bootProcess,
  createWorkflows,
  type DiscoveredModule,
  discoverWorkflowModules,
  type HostDeps,
  type ProcessDefinition,
  type ProcessRoute,
  type ProcessRuntime,
  type RunningHost,
} from '@agent-workflows/host'
import type { Runtime } from '@agent-workflows/runtime'
import type { Pool } from 'pg'
import type { AudioDeps } from '../scope.ts'
import { callerAuth } from './callers.ts'
import type { AudioProcessConfig } from './config.ts'
import { createDoor, type Door, type DoorHandlers, type Fetch } from './door.ts'

export { callerAuth, type CallerAuth, parseDoorTokens, PLATFORM_CALLER, readDoorTokens } from './callers.ts'
export { AUDIO_DOOR_PORT, AUDIO_PORT, type AudioProcessConfig, loadAudioProcessConfig } from './config.ts'
export {
  createDoor,
  type Door,
  DOOR_WORKFLOW_IDS,
  type DoorEnd,
  type DoorEndpoint,
  type DoorEvent,
  type DoorHandler,
  type DoorHandlerDeps,
  type DoorHandlers,
  type Fetch,
} from './door.ts'

/** `src/workflows/<id>/module.ts`: the audio process's own tree, discovered like the host's. */
export const AUDIO_MODULES_DIR = join(import.meta.dir, '..', 'workflows')

/**
 * What the audio process's workflow modules are built from: `HostDeps` plus the journal (its read pool and schema),
 * which the podcast room reads for the show's history and an episode's recorded cost.
 */
export type AudioWorkflowDeps = HostDeps & {
  journal: { db: Pick<Pool, 'query'>; schema: string }
  /** The lanes' config, media port and env, shared with the door: the podcast's production synthesizes on them. */
  audio: Omit<AudioDeps, 'usage'>
}

export interface AudioProcessOptions {
  config: AudioProcessConfig
  /** The door's handlers (`src/door/`), bound to their config. */
  handlers: DoorHandlers
  /** The caller tokens (`readDoorTokens`): read before boot, so a bad file refuses the start. */
  tokens: ReadonlyMap<string, string>
  /** What the door's upstream calls go through (bound per request to its signal). Default: the global `fetch`. */
  fetch?: Fetch
  /** The lanes' deps the workflows synthesize on (`podcast.produce`); the same config the door handlers are bound to. */
  audio: Omit<AudioDeps, 'usage'>
  /** Replaces the discovered modules (tests). */
  modules?: readonly DiscoveredModule[]
}

/**
 * The audio process (concept §8): its workflow tree and the OpenAI-compatible door, on the shared process core. It
 * serves no capability over HTTP (the host does; the CLI would refuse a command two processes declare) and needs no
 * agent: the OpenCode host stays unbuilt until a workflow's first agent step.
 */
export function audioProcess(options: AudioProcessOptions): ProcessDefinition {
  const { config } = options
  let runtime: Runtime | undefined
  let open = () => false
  let door: Door | undefined
  const doorRoutes = (process: ProcessRuntime): ProcessRoute[] => {
    runtime = process.runtime
    open = process.isOpen
    const mounted = door
    return mounted ? [(request, url) => mounted.route(request, url)] : []
  }
  return {
    name: 'audio',
    serviceName: 'agw-audio',
    stateDir: config.stateDir,
    serveCapabilities: false,
    async workflows({ config: base, registry, toolGate, logger, readPool }) {
      const modules = options.modules ?? (await discoverWorkflowModules(AUDIO_MODULES_DIR))
      door = createDoor({
        handlers: options.handlers,
        auth: callerAuth({ tokens: options.tokens, secret: config.secret }),
        runtime: () => {
          if (!runtime) throw new Error('the audio runtime is not built yet')
          return runtime
        },
        isOpen: () => open(),
        logger,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
      const deps: AudioWorkflowDeps = {
        registry,
        toolGate,
        logger,
        journal: { db: readPool, schema: base.schema },
        audio: options.audio,
      }
      return [...(await createWorkflows(deps, modules)), ...door.workflows]
    },
    routes: doorRoutes,
    // The door alone: 7792 also serves the API and `/health`, which a forwarded port must not reach.
    doorOnly: [{ port: config.doorPort, routes: doorRoutes }],
  }
}

export function bootAudio(options: AudioProcessOptions, boot: BootOptions = {}): Promise<RunningHost> {
  return bootProcess(audioProcess(options), options.config, boot)
}
