import { type Cost, costFromUsage, type ResolvedRoute } from '@agent-workflows/routes'
import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { iuConfig } from '../transports/config.ts'
import { within } from '../web/deps.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { readHeader } from './header.ts'
import { readPng, toPng } from './png.ts'
import { readBytes, readJsonBounded, send } from './wire.ts'

const CREATE_TIMEOUT_MS = 90_000
/** How long a prediction may keep running before the poll gives up; a run can ask for more (`pollDeadlineMs`). */
const POLL_DEADLINE_MS = 60_000
const DELIVERY_TIMEOUT_MS = 30_000
/** The create and poll answers are small JSON documents. */
const MAX_JSON_BYTES = 1024 * 1024

/** What Replicate answers about a prediction. A body that does not fit is not trusted: in particular, nothing is billed for it. */
const prediction = z.object({
  id: z.string().optional(),
  status: z.enum(['starting', 'processing', 'succeeded', 'failed', 'canceled', 'aborted']),
  output: z.union([z.string(), z.array(z.string())]).nullish(),
  error: z.string().nullish(),
})
type Prediction = z.infer<typeof prediction>

const running = (status: Prediction['status']) => status === 'starting' || status === 'processing'
/** A prediction that was started and is not failed or cancelled is billed, whatever it goes on to do. */
const billed = (status: Prediction['status']) => status !== 'failed' && status !== 'canceled' && status !== 'aborted'

/** Replicate serves prediction output from its own CDN only; anything else is refused. */
function isReplicateDeliveryUrl(raw: string): boolean {
  const url = URL.parse(raw)
  if (url?.protocol !== 'https:') return false
  const host = url.hostname
  return host === 'replicate.delivery' || host.endsWith('.replicate.delivery')
}

/**
 * The Replicate base: an explicit override wins, otherwise IU's OpenAI base with its trailing `/openai/v1` swapped for
 * `/replicate/v1`. Refuses to guess when the base has no such suffix.
 */
export function replicateBase(openaiBase: string, override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, '')
  const suffix = /\/openai\/v1\/?$/
  if (!suffix.test(openaiBase)) {
    throw fail(
      'NOT_CONFIGURED',
      'image: cannot derive the Replicate base from IU_BASE_URL and REPLICATE_BASE_URL is unset',
    )
  }
  return openaiBase.replace(suffix, '/replicate/v1')
}

/** Where and as whom Replicate is called, read from the env on each call. Throws `NOT_CONFIGURED` before anything else is done. */
export function replicateAccess(deps: ResolvedImageDeps) {
  const env = deps.env()
  const config = iuConfig(env)
  return {
    base: replicateBase(config.openaiBase, env.REPLICATE_BASE_URL),
    headers: { authorization: `Bearer ${config.apiKey}` },
  }
}
export type ReplicateAccess = ReturnType<typeof replicateAccess>

export interface PredictionRun {
  route: ResolvedRoute
  access: ReplicateAccess
  /** The Replicate `input` object. */
  input: Record<string, unknown>
  /** A delivery over this is not what the model is supposed to return. */
  maxDeliveryBytes: number
  /** The longest the poll waits for the prediction to settle; default 60 s. */
  pollDeadlineMs?: number
}

const parse = (json: unknown, wire: string): Prediction => {
  const checked = prediction.safeParse(json)
  if (!checked.success) throw fail('UPSTREAM_ERROR', `${wire} answered with a body that does not fit`, {})
  return checked.data
}

/**
 * Create the prediction and record its price. The create POST starts and bills a prediction. Once it may have landed it
 * is not sent again: only a refused connection, or a 429 (throttled before anything started), repeats it. A dropped or
 * garbled answer is an error that says the prediction may have started.
 */
async function createPrediction(deps: ResolvedImageDeps, ctx: Ctx, { route, access, input }: PredictionRun) {
  const { base, headers } = access
  const created = parse(
    await send({
      retry: deps.retry,
      signal: ctx.signal,
      wire: 'replicate',
      idempotent: false,
      status: (status) => status === 429,
      request: () =>
        deps.fetch(`${base}/models/${route.model}/predictions`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', prefer: 'wait' },
          body: JSON.stringify({ input }),
          redirect: 'error',
          signal: within(ctx.signal, CREATE_TIMEOUT_MS),
        }),
      read: (res) => readJsonBounded(res, 'replicate', MAX_JSON_BYTES, false),
    }),
    'replicate',
  )
  // Replicate bills a started prediction, so the price is recorded here, once, not after the output is in hand:
  // a poll that fails or runs out of time must not leave a billed call off the run.
  const cost = costFromUsage(route.wire, null, route.rate, route.price)
  if (billed(created.status)) {
    ctx.addUsage({
      model: route.model,
      tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      cost: cost.usd,
      costSource: cost.source,
    })
  }
  return { created, cost }
}

/** Poll a running prediction until it settles. The deadline bounds the whole wait. */
async function pollPrediction(
  deps: ResolvedImageDeps,
  ctx: Ctx,
  { access, pollDeadlineMs = POLL_DEADLINE_MS }: PredictionRun,
  started: Prediction,
): Promise<Prediction> {
  const { base, headers } = access
  const id = started.id
  if (!id) throw fail('UPSTREAM_ERROR', 'replicate prediction has no id to poll', {})
  const deadline = Date.now() + pollDeadlineMs
  let current = started
  while (running(current.status)) {
    if (Date.now() >= deadline) throw fail('UPSTREAM_ERROR', `replicate prediction ${id} timed out`, {})
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs))
    ctx.signal.throwIfAborted()
    // The flat path keyed by id, never the `urls.get` the API returns (that points at the public Replicate host).
    // A GET: a transient failure of one poll is retried; the prediction is still running on the other side.
    current = parse(
      await send({
        retry: deps.retry,
        signal: ctx.signal,
        wire: 'replicate poll',
        idempotent: true,
        status: () => true,
        request: () =>
          deps.fetch(`${base}/predictions/${id}`, {
            headers,
            redirect: 'error',
            signal: within(ctx.signal, DELIVERY_TIMEOUT_MS),
          }),
        read: (res) => readJsonBounded(res, 'replicate poll', MAX_JSON_BYTES, true),
      }),
      'replicate poll',
    )
  }
  return current
}

/** The bytes a succeeded prediction delivered, from `replicate.delivery` only and within `maxDeliveryBytes`. */
async function fetchDelivery(deps: ResolvedImageDeps, ctx: Ctx, done: Prediction, maxDeliveryBytes: number) {
  if (done.status !== 'succeeded') {
    throw fail('UPSTREAM_ERROR', `replicate prediction ${done.status}: ${done.error ?? 'unknown error'}`, {})
  }
  const url = Array.isArray(done.output) ? done.output[0] : done.output
  if (!url) throw fail('UPSTREAM_ERROR', 'replicate prediction succeeded with no output URL', {})
  if (!isReplicateDeliveryUrl(url))
    throw fail('UPSTREAM_ERROR', 'replicate output URL is not a replicate.delivery URL', {})
  // A redirect would leave the allowlisted host: it is an error, not something to follow.
  const delivered = await deps.fetch(url, { redirect: 'manual', signal: within(ctx.signal, DELIVERY_TIMEOUT_MS) })
  if (!delivered.ok) throw fail('UPSTREAM_ERROR', `replicate output could not be fetched (${delivered.status})`, {})
  const bytes = await readBytes(delivered, maxDeliveryBytes)
  if (!bytes) throw fail('UPSTREAM_ERROR', `replicate output is over ${maxDeliveryBytes} bytes`, {})
  return bytes
}

/**
 * The one Replicate flow: create (`Prefer: wait`) -> poll only while still running -> fetch the delivered bytes from
 * `replicate.delivery`. The typed capabilities decide what the bytes are.
 */
export async function runPrediction(
  deps: ResolvedImageDeps,
  ctx: Ctx,
  run: PredictionRun,
): Promise<{ bytes: Uint8Array; cost: Cost }> {
  const { created, cost } = await createPrediction(deps, ctx, run)
  const done = running(created.status) ? await pollPrediction(deps, ctx, run, created) : created
  const bytes = await fetchDelivery(deps, ctx, done, run.maxDeliveryBytes)
  return { bytes, cost }
}

/**
 * A delivered image as a PNG. The models deliver PNG or WebP; the header is read first, so a delivery that claims more than
 * `maxPixels` is refused before anything decodes for it.
 */
export async function deliveredPng(raw: Uint8Array, maxPixels: number) {
  const header = readHeader(raw)
  if (!header || (header.format !== 'png' && header.format !== 'webp')) {
    throw fail('UPSTREAM_ERROR', 'replicate output is neither png nor webp (bad magic bytes or header)', {})
  }
  if (header.width * header.height > maxPixels) {
    throw fail('UPSTREAM_ERROR', `replicate output claims ${header.width}x${header.height} pixels, over the bound`, {})
  }
  const out = await toPng(raw)
  const info = readPng(out)
  if (!info) throw fail('UPSTREAM_ERROR', 'replicate output could not be converted to a png', {})
  return { png: out, info }
}
