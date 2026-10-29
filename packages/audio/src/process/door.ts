// The OpenAI-compatible door on the audio process: `/v1/audio/speech` and `/v1/audio/transcriptions`, and the same
// without `/v1` (audio-gateway matched any suffix; anchored here so no API path is ever taken over). Each request is one run of its own
// (concept N6, the pattern of `packages/host/src/capability-runs.ts`): the journal, the run record with cost,
// telemetry and the Argo outbox apply to it like to any workflow. The run is started beside the handler, never in
// front of it, and only observes: the handler's usage events land in an in-memory sink the run's one step reads when
// the request has ended. Recording never delays the audio and a recording failure never fails the request (logged).
import { BEARER_CHALLENGE, type HostWorkflow, RUN_ID_HEADER, startRun } from '@agent-workflows/host'
import { defineWorkflow, type Logger, type Runtime, type Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { CallerAuth } from './callers.ts'

export type DoorEndpoint = 'speech' | 'transcriptions'

/**
 * The slice of the door's usage events (`UsageEvent` of `src/usage.ts`) the run record reads: one `call` per billed
 * upstream call, failed attempts included, and one `request` summary per request.
 */
export interface DoorEvent {
  kind: 'call' | 'request'
  requestId: string
  caller: string
  routeId: string | null
  model: string
  status: number
  costUsd: number | null
  costSource: 'rate' | 'provider' | 'not-billed' | 'unknown'
  inputTokens?: number | null
  outputTokens?: number | null
  cachedTokens?: number | null
  requestedModel?: string
}

/** What the door gives a handler factory, per request, beside its own config: the usage port, the request's id and caller. */
export interface DoorHandlerDeps {
  usage: { record(event: DoorEvent): void }
  requestId(req: Request): string
  caller(req: Request): string | undefined
}

export type DoorHandler = (req: Request) => Promise<Response>

/** `createSpeechHandler` and `createTranscriptionsHandler` of `src/door/`, bound to their config. */
export type DoorHandlers = Record<DoorEndpoint, (deps: DoorHandlerDeps) => DoorHandler>

export const DOOR_WORKFLOW_IDS: Record<DoorEndpoint, string> = {
  speech: 'door.speech',
  transcriptions: 'door.transcriptions',
}

/** After the body ended, how long the run waits for a `request` summary the handler did not send. */
const SUMMARY_GRACE_MS = 2000
/**
 * A request's record ends at the latest this long after it arrived, whatever the body does (a stream nobody reads to
 * the end and nobody cancels): the run then records what arrived, never stays running. Far above a long transcription.
 */
const RECORD_MAX_MS = 60 * 60_000
/** A sink no run ever read (the run was never driven here) is dropped this long after its request ended. */
const ORPHAN_MS = 10 * 60_000

/** Paths the door owns, exactly: `/v1/audio/…` and the base form without `/v1` legacy clients use. */
const DOOR_PATH = /^(?:\/v1)?\/audio\/(speech|transcriptions)$/

const doorError = (status: number, message: string, type: string, headers?: Record<string, string>) =>
  Response.json({ error: { message, type } }, { status, headers })

/** One request's events, read by its run. */
class Sink {
  readonly calls: DoorEvent[] = []
  request: DoorEvent | undefined
  ended = false
  readonly settled: Promise<void>
  private settle = () => {}
  private readonly bound: ReturnType<typeof setTimeout>
  private orphan: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly drop: () => void) {
    this.settled = new Promise((resolve) => {
      this.settle = resolve
    })
    this.bound = setTimeout(() => this.end(), RECORD_MAX_MS)
    this.bound.unref()
  }

  record(event: DoorEvent) {
    if (event.kind === 'call') this.calls.push(event)
    else {
      this.request = event
      this.settle()
    }
  }

  /** The request is over (body ended, failed or cancelled; client gone; the bound hit). Idempotent. */
  end() {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.bound)
    setTimeout(() => this.settle(), SUMMARY_GRACE_MS).unref()
    this.orphan = setTimeout(() => this.drop(), ORPHAN_MS)
    this.orphan.unref()
  }

  close() {
    clearTimeout(this.bound)
    clearTimeout(this.orphan)
    this.drop()
  }
}

const DoorInput = z.object({
  /** The authenticated caller (its door token's name, `agw` for the API secret). */
  caller: z.string().min(1),
  /** `x-audio-source`, when sent: the label the handler's events carry. */
  source: z.string().nullable(),
  path: z.string(),
})

const DoorOutput = z.object({
  status: z.number().nullable(),
  route: z.string().nullable(),
  model: z.string().nullable(),
  requestedModel: z.string().nullable(),
  costUsd: z.number().nullable(),
  calls: z.number(),
  /** False when the handler ended without a `request` summary (a cut stream, a thrown handler). */
  complete: z.boolean(),
})

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    promise.then(resolve, reject)
  })

function usageOf(event: DoorEvent): Usage {
  const unpriced = event.costSource === 'unknown' || event.costUsd === null
  return {
    model: event.model,
    tokens: {
      input: event.inputTokens ?? 0,
      output: event.outputTokens ?? 0,
      cacheRead: event.cachedTokens ?? 0,
      reasoning: 0,
    },
    // A failed attempt is not billed: priced at 0 by the route's rate, never left unpriced.
    cost: unpriced ? null : event.costUsd,
    costSource: unpriced ? 'unknown' : event.costSource === 'provider' ? 'provider' : 'rate',
  }
}

export interface Door {
  /** The two door workflows: registered with the runtime, never an API route or a CLI command. */
  workflows: HostWorkflow[]
  /** Answers a door path, `undefined` for any other. */
  route(request: Request, url: URL): Promise<Response> | undefined
}

export interface DoorOptions {
  handlers: DoorHandlers
  auth: CallerAuth
  runtime: () => Runtime
  isOpen: () => boolean
  logger: Logger
}

export function createDoor(options: DoorOptions): Door {
  const { auth, logger } = options
  // By run id: the run's step finds its request's events under its own id.
  const sinks = new Map<string, Sink>()

  const workflowOf = (endpoint: DoorEndpoint) =>
    defineWorkflow({
      id: DOOR_WORKFLOW_IDS[endpoint],
      version: '2026-10-29.2',
      input: DoorInput,
      output: DoorOutput,
      async run(ctx) {
        return ctx.step('request', async ({ addUsage, signal }) => {
          const sink = sinks.get(ctx.runId)
          // Resumed in a process that never served the request (a restart mid-request): its events died with it.
          if (!sink) throw new Error('the request was served by a process that has stopped; its usage is lost')
          await raceAbort(sink.settled, signal)
          sink.close()
          for (const call of sink.calls) addUsage(usageOf(call))
          const summary = sink.request
          const costs = sink.calls.map((call) => usageOf(call).cost ?? null)
          // A request is priced only when every call is: a partial sum would read as the whole cost.
          const costUsd =
            costs.length > 0 && costs.every((c): c is number => c !== null) ? costs.reduce((a, c) => a + c, 0) : null
          return {
            status: summary?.status ?? null,
            route: summary?.routeId ?? sink.calls.at(-1)?.routeId ?? null,
            model: summary?.model ?? sink.calls.at(-1)?.model ?? null,
            requestedModel: summary?.requestedModel ?? null,
            costUsd,
            calls: sink.calls.length,
            complete: summary !== undefined,
          }
        })
      },
    })

  const workflows = { speech: workflowOf('speech'), transcriptions: workflowOf('transcriptions') }

  /** Records the request as run `runId`, in the background; a failure is logged and drops the sink, never thrown. */
  function startRecord(endpoint: DoorEndpoint, request: Request, runId: string, input: z.infer<typeof DoorInput>) {
    // Purpose and trace only: an `Idempotency-Key` would fold two real requests into one record.
    const headers = new Headers()
    for (const name of ['x-agw-purpose', 'traceparent']) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    startRun({ runtime: options.runtime() }, workflows[endpoint], input, headers, { runId }).catch((error: unknown) => {
      sinks.get(runId)?.close()
      logger.error('door request not recorded', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  async function serve(endpoint: DoorEndpoint, request: Request, path: string): Promise<Response> {
    if (!options.isOpen()) return doorError(503, 'service is shutting down', 'proxy_error')
    const caller = auth(request.headers.get('authorization'))
    if (!caller) return doorError(401, 'unauthorized', 'invalid_request_error', BEARER_CHALLENGE)

    // The run id is chosen here, so `agw-run-id` goes out with the first byte and nothing waits on the journal.
    const runId = Bun.randomUUIDv7()
    const sink = new Sink(() => sinks.delete(runId))
    sinks.set(runId, sink)
    request.signal.addEventListener('abort', () => sink.end(), { once: true })
    startRecord(endpoint, request, runId, { caller, source: request.headers.get('x-audio-source'), path })

    // Built per request: the request's id and caller go in explicitly, every event of the handler is this request's.
    const handler = options.handlers[endpoint]({
      usage: {
        record(event) {
          if (event.requestId !== runId)
            logger.warn('door usage event under another request id', { runId, requestId: event.requestId })
          sink.record(event)
        },
      },
      requestId: () => runId,
      caller: () => caller,
    })
    let response: Response
    try {
      response = await handler(request)
    } catch (error) {
      // The handlers answer their own failures; a throw past them is answered as legacy's top-level catch did.
      sink.end()
      const message = error instanceof Error ? error.message : 'internal error'
      logger.error('door handler threw', { runId, error: message })
      return doorError(500, message, 'proxy_error', { [RUN_ID_HEADER]: runId })
    }
    const body = response.body ? onEnd(response.body, () => sink.end()) : null
    if (!body) sink.end()
    const answer = new Response(body, response)
    answer.headers.set(RUN_ID_HEADER, runId)
    return answer
  }

  return {
    workflows: [
      { workflow: workflows.speech, summary: 'One door speech request', internal: true },
      { workflow: workflows.transcriptions, summary: 'One door transcription request', internal: true },
    ],
    route(request, url) {
      if (request.method !== 'POST') return undefined
      const endpoint = DOOR_PATH.exec(url.pathname)?.[1] as DoorEndpoint | undefined
      return endpoint ? serve(endpoint, request, url.pathname) : undefined
    },
  }
}

/** The same bytes, pulled as the client reads them; `end` runs once when the body ended, failed or was cancelled. */
function onEnd(body: ReadableStream<Uint8Array>, end: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            end()
          } else controller.enqueue(value)
        } catch (error) {
          end()
          controller.error(error)
        }
      },
      cancel(reason) {
        end()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
