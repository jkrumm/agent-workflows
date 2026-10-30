// The image door of the host process: `POST /door/image/{generate,edit,enhance}`, the wire the MacBook studio app already
// speaks (`contract.ts`), so the app only changes its base URL and token. Each request is one run of its own (concept N6,
// the pattern of `packages/audio/src/process/door.ts` and `../capability-runs.ts`): the journal, the run record with cost,
// telemetry and the usage outbox apply to it like to any workflow. The run id is chosen up front and goes out in
// `agw-run-id`; the run is started in the background and its one step does the upstream work with the step's `addUsage`
// and `signal`, pushing the SSE frames to the response as they happen. The run input is JSON only (parameters, never
// image bytes); the bytes wait in an in-memory job, found by run id, and are dropped when the step ends.
import {
  type EnhanceOutput,
  type EnhanceParams,
  type ImageDeps,
  type ImageRequest,
  requestImages,
  resolveImageDeps,
} from '@agent-workflows/capabilities'
import { defineWorkflow, type Logger, type Runtime, type Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import { BEARER_CHALLENGE } from '../auth.ts'
import { RUN_ID_HEADER } from '../capability-runs.ts'
import { type CallerAuth, callerAuth } from '../door-tokens.ts'
import { type HostWorkflow, purposeOf, startRun } from '../operations.ts'
import {
  MAX_JSON_BYTES,
  MAX_MULTIPART_BYTES,
  parseEdit,
  parseJson,
  RequestError,
  readBounded,
  UPLOAD_DEADLINE_MS,
} from './body.ts'
import {
  type GenerateResponse,
  generateRequestSchema,
  type PlanResponse,
  planRequestSchema,
  type StreamEvent,
} from './contract.ts'
import {
  type Failure,
  doorFailure,
  failureOf,
  generateEnvelope,
  imageRequest,
  planResponse,
  planToEnhance,
  ruleError,
  sseFrame,
} from './convert.ts'

export type ImageEndpoint = 'generate' | 'edit' | 'enhance'

export const IMAGE_DOOR_WORKFLOW_IDS: Record<ImageEndpoint, string> = {
  generate: 'door.image.generate',
  edit: 'door.image.edit',
  enhance: 'door.image.enhance',
}

/** The door's paths, exactly. Anything else under `/door` is a 404 here and never reaches the API. */
const PATHS: Record<string, ImageEndpoint> = {
  '/door/image/generate': 'generate',
  '/door/image/edit': 'edit',
  '/door/image/enhance': 'enhance',
}
const DOOR_PREFIX = /^\/door(?:\/|$)/

/**
 * How long a request waits for its run to take the job: the journal normally answers in milliseconds. A run that never
 * starts (journal down, admission refused) fails the request with a 503 rather than hanging it; no work is done
 * unrecorded.
 */
const START_WAIT_MS = 15_000
/**
 * How many door requests are in flight at once, from the moment a body starts to arrive until the request is over (its
 * response sent or its stream closed or cancelled): each holds up to a full request in memory, and each is a billed
 * upstream call. The fifth is answered `503` with `retry-after`.
 */
export const MAX_IN_FLIGHT = 4
const RETRY_AFTER_S = 5
/** An abandoned job's entry (its bytes already dropped) is forgotten this long after, in case its run never starts. */
const ORPHAN_MS = 10 * 60_000

/** What the planner call is given, and answers: `image.enhance`, in process. */
export type Enhance = (input: EnhanceParams, io: StepIo) => Promise<EnhanceOutput>

/** What a step hands the upstream work: the step's usage sink and its signal (with the client's). */
export interface StepIo {
  addUsage: (usage: Usage) => void
  signal: AbortSignal
}

/** What `hostProcess` is given to serve the door. */
export interface ImageDoorOptions {
  /** The caller tokens (`readDoorTokens`): read before boot, so a bad file refuses the start. */
  tokens: ReadonlyMap<string, string>
  /** Replaces the image deps (tests): the fetch, env, retry and route the generate and edit calls run on. */
  image?: ImageDeps
  /** Replaces the planner call (tests). Default: the registry's `image.enhance`. */
  enhance?: Enhance
  /** Replaces the upload deadline (`UPLOAD_DEADLINE_MS`) and the in-flight cap (`MAX_IN_FLIGHT`) (tests). */
  limits?: { uploadDeadlineMs?: number; maxInFlight?: number }
}

/** The part of Bun's server a door needs: lifting the idle timeout of one request. */
export interface ServerHandle {
  timeout(request: Request, seconds: number): void
}

export interface ImageDoor {
  /** The three door workflows: registered with the runtime, never an API route or a CLI command. */
  workflows: HostWorkflow[]
  /** Answers a request under `/door`, `undefined` for any other path. */
  route(request: Request, url: URL, server?: ServerHandle): Promise<Response> | undefined
}

export interface ImageDoorDeps {
  options: ImageDoorOptions
  secret: string
  env: Record<string, string | undefined>
  /** The registry's planner call, used unless `options.enhance` replaces it. */
  enhance: Enhance
  runtime: () => Runtime
  isOpen: () => boolean
  logger: Logger
}

const DoorInput = z.object({
  /** The authenticated caller (its door token's name, `agw` for the API secret). */
  caller: z.string().min(1),
  endpoint: z.enum(['generate', 'edit', 'enhance']),
  path: z.string(),
  /** The request's parameters, as the studio contract validated them: prompts and settings, never image bytes. */
  request: z.record(z.string(), z.unknown()),
})

const DoorOutput = z.object({
  /** The status the client was answered with; 499 when it had gone. */
  status: z.number(),
  ended: z.enum(['done', 'client-gone']),
  /** The model that served it: the studio's id of the routed seat, the planner's model for enhance. */
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  images: z.number(),
  bytes: z.number(),
  /** Preview frames sent. */
  partials: z.number(),
})

const GONE_STATUS = 499

interface Done {
  response: GenerateResponse | PlanResponse
  model: string
  images: number
  bytes: number
}

/** A parsed, checked request: what the run journals, whether it streams, and the upstream work. */
interface Prepared {
  request: Record<string, unknown>
  streaming: boolean
  work(io: StepIo, emit: (event: StreamEvent) => void): Promise<Done>
}

type Outcome = { ok: true; response: Done['response'] } | { ok: false; failure: Failure }

/** Frames waiting for the response body: pushed as they happen, pulled as the client reads. */
class FrameQueue {
  private readonly items: Uint8Array[] = []
  private waiting: ((frame: Uint8Array | null) => void) | undefined
  private closed = false

  push(frame: Uint8Array) {
    if (this.closed) return
    if (this.waiting) {
      const wake = this.waiting
      this.waiting = undefined
      wake(frame)
    } else this.items.push(frame)
  }

  close() {
    this.closed = true
    this.waiting?.(null)
    this.waiting = undefined
  }

  next(): Promise<Uint8Array | null> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

/** One request between its handler and its run's step. */
class Job {
  readonly controller = new AbortController()
  readonly frames = new FrameQueue()
  readonly outcome: Promise<Outcome>
  readonly firstPartial: Promise<void>
  claimed = false
  abandoned = false
  gone = false
  partials = 0
  /** Dropped as soon as the step has it or the request is given up: the references' bytes live in its closure. */
  prepared: Prepared | undefined
  private settleOutcome: (outcome: Outcome) => void = () => {}
  private seenPartial: () => void = () => {}

  constructor(prepared: Prepared) {
    this.prepared = prepared
    this.outcome = new Promise((resolve) => {
      this.settleOutcome = resolve
    })
    this.firstPartial = new Promise((resolve) => {
      this.seenPartial = resolve
    })
  }

  settle(outcome: Outcome) {
    this.settleOutcome(outcome)
  }

  /** A preview from the upstream call. A client that has gone aborts the call (the step then ends `client-gone`). */
  emit(event: StreamEvent) {
    if (this.gone) throw new Error('the client went away')
    if (event.type === 'partial_image') this.partials++
    this.frames.push(sseFrame(event))
    this.seenPartial()
  }

  clientGone() {
    if (this.gone) return
    this.gone = true
    this.controller.abort(new DOMException('the client went away', 'AbortError'))
    this.frames.close()
  }
}

const withRunId = (runId: string) => ({ [RUN_ID_HEADER]: runId })

function failureResponse(failure: Failure, headers: Record<string, string> = {}): Response {
  return Response.json(failure.body, { status: failure.status, headers })
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const decodedBytes = (b64: string) => Buffer.byteLength(b64, 'base64')

export function createImageDoor(deps: ImageDoorDeps): ImageDoor {
  const { options, logger } = deps
  const auth: CallerAuth = callerAuth({ tokens: options.tokens, secret: deps.secret })
  const images = resolveImageDeps({ env: deps.env, ...options.image })
  const enhance: Enhance = options.enhance ?? deps.enhance
  // By run id: the run's step finds its request's job under its own id.
  const jobs = new Map<string, Job>()

  const workflowOf = (endpoint: ImageEndpoint) =>
    defineWorkflow({
      id: IMAGE_DOOR_WORKFLOW_IDS[endpoint],
      version: '2026-10-30.1',
      input: DoorInput,
      output: DoorOutput,
      async run(ctx) {
        return ctx.step('serve', async ({ addUsage, signal: stepSignal }) => {
          const job = jobs.get(ctx.runId)
          // Resumed in a process that never served the request (a restart mid-request): its bytes died with it.
          if (!job)
            throw new Error('the request was served by a process that has stopped; its result was not delivered')
          jobs.delete(ctx.runId)
          const prepared = job.prepared
          job.prepared = undefined
          if (job.abandoned || !prepared) {
            if (job.gone) return summary(GONE_STATUS, 'client-gone', null, null, job)
            throw new Error('the request was given up before its run started')
          }
          job.claimed = true

          // The step's own usage sink, summed: the summary's cost is complete only when every call was priced.
          let cost = 0
          let calls = 0
          let unpriced = false
          const metered = (usage: Usage) => {
            addUsage(usage)
            calls++
            if (typeof usage.cost !== 'number') unpriced = true
            else cost += usage.cost
          }
          const costUsd = () => (calls > 0 && !unpriced ? cost : null)

          const signal = AbortSignal.any([stepSignal, job.controller.signal])
          try {
            if (signal.aborted) throw new Error('cancelled before it started')
            const done = await prepared.work({ addUsage: metered, signal }, (event) => job.emit(event))
            job.settle({ ok: true, response: done.response })
            return summary(job.gone ? GONE_STATUS : 200, job.gone ? 'client-gone' : 'done', done, costUsd(), job)
          } catch (error) {
            // The client going away is its own end, whatever the call threw when it was aborted.
            if (job.gone) {
              job.settle({ ok: false, failure: doorFailure(GONE_STATUS, 'the client went away', 'proxy_error') })
              return summary(GONE_STATUS, 'client-gone', null, costUsd(), job)
            }
            const failure = failureOf(error)
            // What the client is not told (an unexpected error, a transport failure's text) is logged with the run id.
            if (failure.status === 500 || failure.detail)
              logger.error('image door request failed', { runId: ctx.runId, error: failure.detail ?? messageOf(error) })
            job.settle({ ok: false, failure })
            throw new Error(`${failure.status} ${failure.body.error.type}: ${failure.body.error.message}`, {
              cause: error,
            })
          }
        })
      },
    })

  const workflows = { generate: workflowOf('generate'), edit: workflowOf('edit'), enhance: workflowOf('enhance') }

  /** The upstream work of an image request, previews pushed to `emit`, the envelope built from the answer. */
  function imageWork(fields: Parameters<typeof generateEnvelope>[1], request: ImageRequest): Prepared['work'] {
    return async (io, emit) => {
      const result = await requestImages(images, io, {
        ...request,
        onPartial: (partial) =>
          emit({
            type: 'partial_image',
            partial_image_index: partial.index,
            b64_json: partial.b64,
            format: partial.format,
          }),
      })
      const response = generateEnvelope(result, fields)
      return {
        response,
        model: response.model,
        images: response.images.length,
        bytes: response.images.reduce((sum, image) => sum + decodedBytes(image.b64_json), 0),
      }
    }
  }

  async function prepare(endpoint: ImageEndpoint, request: Request): Promise<Prepared> {
    const deadlineMs = options.limits?.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS
    if (endpoint === 'edit') {
      const body = await readBounded(request, MAX_MULTIPART_BYTES, deadlineMs)
      const { fields, references, mask } = await parseEdit(body, request.headers.get('content-type'))
      const rule = ruleError(fields, true)
      if (rule) throw new RequestError(400, rule)
      const file = ({ name, mime, bytes }: { name: string; mime: string; bytes: Uint8Array }) => ({
        name,
        mime,
        bytes: bytes.length,
      })
      return {
        request: { ...fields, images: references.map(file), mask: mask ? file(mask) : null },
        streaming: fields.partial_images > 0,
        work: imageWork(fields, imageRequest(fields, { references, ...(mask ? { mask } : {}) })),
      }
    }
    const body = await readBounded(request, MAX_JSON_BYTES, deadlineMs)
    if (endpoint === 'generate') {
      const fields = await parseJson(body, generateRequestSchema)
      const rule = ruleError(fields, false)
      if (rule) throw new RequestError(400, rule)
      return {
        request: { ...fields },
        streaming: fields.partial_images > 0,
        work: imageWork(fields, imageRequest(fields)),
      }
    }
    const fields = await parseJson(body, planRequestSchema)
    return {
      request: { ...fields },
      streaming: false,
      work: async (io) => {
        const plan = await enhance(planToEnhance(fields), io)
        return { response: planResponse(plan), model: plan.enhanceModel, images: 0, bytes: 0 }
      },
    }
  }

  function summary(status: number, ended: 'done' | 'client-gone', done: Done | null, costUsd: number | null, job: Job) {
    return {
      status,
      ended,
      model: done?.model ?? null,
      costUsd,
      images: done?.images ?? 0,
      bytes: done?.bytes ?? 0,
      partials: job.partials,
    }
  }

  /** The headers the run is started with: purpose and trace only (an `Idempotency-Key` would fold two real requests into one record), the caller from the credential. */
  function runHeaders(request: Request, caller: string): Headers {
    const headers = new Headers()
    for (const name of ['x-agw-purpose', 'traceparent']) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    // The run's caller is the credential's name, never a header the client sent (`startRun` reads it from here).
    headers.set('x-agw-caller', caller)
    return headers
  }

  /** Records the request as run `runId`, in the background; a failure is logged and gives the request up, never thrown. */
  function startRecord(
    endpoint: ImageEndpoint,
    headers: Headers,
    runId: string,
    input: z.infer<typeof DoorInput>,
    giveUp: (failure: Failure) => void,
  ) {
    Promise.resolve()
      .then(() => startRun({ runtime: deps.runtime() }, workflows[endpoint], input, headers, { runId }))
      .catch((error: unknown) => {
        logger.error('image door request not recorded', { runId, error: messageOf(error) })
        giveUp(doorFailure(503, 'the request could not be recorded', 'proxy_error'))
      })
  }

  let inFlight = 0

  async function serve(
    endpoint: ImageEndpoint,
    request: Request,
    path: string,
    server?: ServerHandle,
  ): Promise<Response> {
    if (!deps.isOpen()) return failureResponse(doorFailure(503, 'service is shutting down', 'proxy_error'))
    const caller = auth(request.headers.get('authorization'))
    if (!caller) {
      return Response.json(doorFailure(401, 'unauthorized', 'invalid_request_error').body, {
        status: 401,
        headers: BEARER_CHALLENGE,
      })
    }
    // Cheap checks first: a purpose the run could not be started with is the client's 400, before anything is read.
    const headers = runHeaders(request, caller)
    try {
      purposeOf(headers)
    } catch (error) {
      return failureResponse(doorFailure(400, messageOf(error), 'invalid_request_error'))
    }
    if (request.signal.aborted) return failureResponse(doorFailure(GONE_STATUS, 'the client went away', 'proxy_error'))

    // A slot for the whole request, freed exactly once however it ends.
    if (inFlight >= (options.limits?.maxInFlight ?? MAX_IN_FLIGHT)) {
      return Response.json(doorFailure(503, 'too many image requests in flight', 'proxy_error').body, {
        status: 503,
        headers: { 'retry-after': String(RETRY_AFTER_S) },
      })
    }
    inFlight++
    let held = true
    const release = () => {
      if (!held) return
      held = false
      inFlight--
    }

    // An image can take minutes to come back: the server's idle timeout (255 s at most) would cut a held request. The
    // upstream calls carry their own hang guards.
    server?.timeout(request, 0)

    let prepared: Prepared
    try {
      prepared = await prepare(endpoint, request)
    } catch (error) {
      release()
      if (error instanceof RequestError) {
        return failureResponse(doorFailure(error.status, error.message, 'invalid_request_error'))
      }
      logger.error('image door request could not be read', { error: messageOf(error) })
      return failureResponse(doorFailure(500, 'internal error', 'proxy_error'))
    }
    // The client may have gone while the body was still arriving: no job, no run, no upstream call.
    if (request.signal.aborted) {
      release()
      return failureResponse(doorFailure(GONE_STATUS, 'the client went away', 'proxy_error'))
    }

    // The run id is chosen here, so `agw-run-id` goes out with the response and nothing waits on the journal for it.
    const runId = Bun.randomUUIDv7()
    const streaming = prepared.streaming
    const input = {
      caller,
      endpoint,
      path,
      request: JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>,
    }
    const job = new Job(prepared)
    jobs.set(runId, job)

    const giveUp = (failure: Failure) => {
      if (job.claimed || job.abandoned) return
      job.abandoned = true
      job.prepared = undefined
      job.settle({ ok: false, failure })
      setTimeout(() => jobs.delete(runId), ORPHAN_MS).unref()
    }
    request.signal.addEventListener(
      'abort',
      () => {
        job.clientGone()
        giveUp(doorFailure(GONE_STATUS, 'the client went away', 'proxy_error'))
      },
      { once: true },
    )
    const startTimer = setTimeout(
      () => giveUp(doorFailure(503, 'the request could not be recorded in time', 'proxy_error')),
      START_WAIT_MS,
    )
    startTimer.unref()
    startRecord(endpoint, headers, runId, input, giveUp)

    const responseHeaders = withRunId(runId)
    let handedToStream = false
    try {
      if (!streaming) {
        const outcome = await job.outcome
        return outcome.ok
          ? Response.json(outcome.response, { headers: responseHeaders })
          : failureResponse(outcome.failure, responseHeaders)
      }
      // Streaming: a failure before the first preview is a plain JSON error with its status; from the first preview on
      // the stream has begun and ends in exactly one `completed` or one `error` frame.
      const first = await Promise.race([job.firstPartial.then(() => 'partial' as const), job.outcome])
      if (first !== 'partial' && !first.ok) return failureResponse(first.failure, responseHeaders)
      void job.outcome.then((outcome) => {
        job.frames.push(
          sseFrame(
            outcome.ok
              ? { type: 'completed', response: outcome.response as GenerateResponse }
              : { type: 'error', error: outcome.failure.body.error },
          ),
        )
        job.frames.close()
      })
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const frame = await job.frames.next()
            if (frame) controller.enqueue(frame)
            else {
              controller.close()
              release()
            }
          },
          cancel() {
            job.clientGone()
            release()
          },
        },
        { highWaterMark: 0 },
      )
      handedToStream = true
      return new Response(body, {
        headers: { ...responseHeaders, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      })
    } finally {
      clearTimeout(startTimer)
      if (!handedToStream) release()
    }
  }

  return {
    workflows: [
      { workflow: workflows.generate, summary: 'One image door generate request', internal: true },
      { workflow: workflows.edit, summary: 'One image door edit request', internal: true },
      { workflow: workflows.enhance, summary: 'One image door enhance request', internal: true },
    ],
    route(request, url, server) {
      if (!DOOR_PREFIX.test(url.pathname)) return undefined
      const endpoint = PATHS[url.pathname]
      if (!endpoint) return Promise.resolve(failureResponse(doorFailure(404, 'not found', 'invalid_request_error')))
      if (request.method !== 'POST') {
        const refused = doorFailure(405, 'method not allowed', 'invalid_request_error')
        return Promise.resolve(Response.json(refused.body, { status: 405, headers: { allow: 'POST' } }))
      }
      return serve(endpoint, request, url.pathname, server)
    },
  }
}
