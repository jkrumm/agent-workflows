import type { AudioConfig } from './config.ts'
import { ffmpegMedia, type MediaPort } from './media/audio.ts'
import { type AudioLane, type AudioRoute, type AudioRouteId, audioRoutes } from './routes.ts'
import {
  type CallEndpoint,
  type CallEvent,
  unitsOf,
  type Measure,
  priceCall,
  type RequestEndpoint,
  type RequestEvent,
  type UsageEvent,
  type UsagePort,
} from './usage.ts'

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface AudioLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** Everything the lanes and the door handlers reach outside themselves. Only `config` and `usage` are required. */
export interface AudioDeps {
  config: AudioConfig
  usage: UsagePort
  clock?: Clock
  fetch?: Fetch
  /** The ffmpeg/ffprobe boundary; default spawns the host binaries. */
  media?: MediaPort
  /** The env `AGW_ROUTES` overrides are read from, once, when a handler or scope is built. Default `process.env`. */
  env?: Record<string, string | undefined>
  log?: AudioLog
  /** The request id stamped on every usage event of one request. Default: a fresh UUID. */
  requestId?: (req: Request) => string
  /** Who called, when the `x-audio-source` header is absent (e.g. from a mapped bearer token). Default `unknown`. */
  caller?: (req: Request) => string | undefined
}

export const REAL_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) }

const CONSOLE_LOG: AudioLog = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
}

export interface Resolved {
  config: AudioConfig
  usage: UsagePort
  clock: Clock
  fetch: Fetch
  media: MediaPort
  routes: Readonly<Record<AudioRouteId, AudioRoute>>
  log: AudioLog
}

export function resolveDeps(deps: AudioDeps): Resolved {
  return {
    config: deps.config,
    usage: deps.usage,
    clock: deps.clock ?? REAL_CLOCK,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    media:
      deps.media ??
      ffmpegMedia({ mp3BitrateKbps: deps.config.ttsBitrateKbps, opusBitrateKbps: deps.config.ttsOpusBitrateKbps }),
    routes: audioRoutes(deps.env),
    log: deps.log ?? CONSOLE_LOG,
  }
}

/** What a request accumulated for its summary event; the lanes fill it as they learn it. */
export interface RequestMeta {
  mode?: string
  lane?: string
  chunks?: number
  languageCode?: string
  voice?: string
  title?: string
  outputText?: string
  audioSeconds?: number
  bytesOut?: number
  retries: number
  calls: number
  unpricedCalls: number
  costUsd: number
}

export interface CallInput extends Measure {
  endpoint: CallEndpoint
  routeId: string | null
  model: string
  status: number
  latencyMs: number
  bytesOut?: number | null
  errorText?: string | null
}

export type SummaryInput = Omit<
  RequestEvent,
  | 'kind'
  | 'requestId'
  | 'caller'
  | 'units'
  | 'quantity'
  | 'costUsd'
  | 'costSource'
  | 'priceVerified'
  | 'calls'
  | 'unpricedCalls'
  | 'retries'
> & { endpoint: RequestEndpoint }

/**
 * One request's view of the deps: its id and caller, the route table, and the usage bookkeeping. Every billed upstream
 * call goes through `call` (priced and recorded at once), the request ends with one `summary`. In-process callers
 * (the podcast's production stage) open their own with `createAudioScope`.
 */
export class AudioScope {
  readonly meta: RequestMeta = { retries: 0, calls: 0, unpricedCalls: 0, costUsd: 0 }
  private readonly quantities = new Map<string, number>()

  constructor(
    readonly deps: Resolved,
    readonly requestId: string,
    readonly caller: string,
  ) {}

  get config() {
    return this.deps.config
  }

  get log() {
    return this.deps.log
  }

  route(id: string): AudioRoute {
    const route = this.deps.routes[id as AudioRouteId]
    if (!route) throw new Error(`audio route "${id}" is not in the route table`)
    return route
  }

  /** The route id serving `model` on one of `wires`, or null. */
  routeIdForModel(model: string, lanes: readonly AudioLane[]): AudioRouteId | null {
    if (!model) return null
    for (const route of Object.values(this.deps.routes)) {
      if (route.model === model && lanes.includes(route.lane)) return route.id
    }
    return null
  }

  retried(): void {
    this.meta.retries++
  }

  /** Price and record one billed upstream call. Never blocks on the port. */
  call(input: CallInput): CallEvent {
    const route = input.routeId ? this.deps.routes[input.routeId as AudioRouteId] : undefined
    const priced = priceCall(route, input.status, input)
    const event: CallEvent = {
      kind: 'call',
      requestId: this.requestId,
      caller: this.caller,
      ...input,
      ...priced,
      bytesOut: input.bytesOut ?? null,
      errorText: input.errorText ?? null,
    }
    this.meta.calls++
    if (priced.costUsd === null) this.meta.unpricedCalls++
    else this.meta.costUsd += priced.costUsd
    if (input.routeId && priced.quantity !== null) {
      this.quantities.set(input.routeId, (this.quantities.get(input.routeId) ?? 0) + priced.quantity)
    }
    this.emit(event)
    return event
  }

  /** The request's one summary event: totals over its calls, quantity of the serving route. */
  summary(input: SummaryInput): RequestEvent {
    const route = input.routeId ? this.deps.routes[input.routeId as AudioRouteId] : undefined
    const event: RequestEvent = {
      kind: 'request',
      requestId: this.requestId,
      caller: this.caller,
      ...input,
      units: route ? unitsOf(route) : null,
      quantity: input.routeId ? (this.quantities.get(input.routeId) ?? null) : null,
      costUsd: this.meta.unpricedCalls > 0 ? null : this.meta.costUsd,
      costSource: this.meta.unpricedCalls > 0 ? 'unknown' : this.meta.calls === 0 ? 'not-billed' : 'rate',
      priceVerified: route && (route.price || route.rate) ? route.priceVerified === true : null,
      calls: this.meta.calls,
      unpricedCalls: this.meta.unpricedCalls,
      retries: this.meta.retries,
    }
    this.emit(event)
    return event
  }

  private emit(event: UsageEvent): void {
    const warn = (error: unknown) =>
      this.deps.log.warn('usage port failed', {
        requestId: this.requestId,
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    try {
      const pending = this.deps.usage.record(event)
      if (pending) pending.catch(warn)
    } catch (error) {
      warn(error)
    }
  }
}

/** A scope for in-process callers (the podcast's production stage): their calls are priced and recorded the same way. */
export function createAudioScope(deps: AudioDeps, opts: { requestId: string; caller: string }): AudioScope {
  return new AudioScope(resolveDeps(deps), opts.requestId, opts.caller)
}
