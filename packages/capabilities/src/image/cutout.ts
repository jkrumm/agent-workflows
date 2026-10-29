import { costFromUsage } from '@agent-workflows/routes'
import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { iuConfig } from '../transports/config.ts'
import { within } from '../web/deps.ts'
import type { ImageRouteId, ResolvedImageDeps } from './deps.ts'
import { readInputImage } from './files.ts'
import { displayedSize, readHeader } from './header.ts'
import { MIME, readPng, toPng } from './png.ts'
import { readBytes, readJsonBounded, send } from './wire.ts'

/**
 * recraft's documented input limits (image-gateway `CUTOUT_LIMITS`), enforced for both models so the contract is uniform.
 * `maxImageBytes` bounds the file sent (the source as it is, or its re-encode after an EXIF rotation); the pixel and edge
 * limits are checked on the header before anything decodes.
 */
export const CUTOUT_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000,
  minEdge: 256,
  maxEdge: 4096,
} as const

export const CUTOUT_MODELS = ['recraft', 'bria'] as const

export const cutoutInput = z.object({
  file: z
    .string()
    .min(1)
    .describe('Absolute path of the image on this host (png, jpeg, webp; 5 MB, sides 256-4096 px, 16 MP)'),
  model: z
    .enum(CUTOUT_MODELS)
    .default('recraft')
    .describe('recraft: $0.01, keeps the resolution. bria: $0.018, may downscale to 1024 px'),
})

export const cutoutOutput = z.object({
  id: z.string(),
  model: z.string(),
  image: z.object({
    b64: z.string().describe('The RGBA PNG, base64'),
    bytes: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
    hasAlpha: z.boolean(),
  }),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type CutoutOutput = z.infer<typeof cutoutOutput>

const CREATE_TIMEOUT_MS = 90_000
const POLL_DEADLINE_MS = 60_000
const DELIVERY_TIMEOUT_MS = 30_000
/** A cutout is one image: a delivery over this is not one. */
const MAX_DELIVERY_BYTES = 64 * 1024 * 1024

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
/** The create and poll answers are small JSON documents. */
const MAX_JSON_BYTES = 1024 * 1024
/** recraft keeps the input's pixels and bria shrinks them, so an output past twice the input limit is not a cutout. */
const MAX_DELIVERY_PIXELS = 2 * CUTOUT_LIMITS.maxPixels

/** Replicate serves prediction output from its own CDN only; anything else is refused. */
export function isReplicateDeliveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))
    )
  } catch {
    return false
  }
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
      'image.cutout: cannot derive the Replicate base from IU_BASE_URL and REPLICATE_BASE_URL is unset',
    )
  }
  return openaiBase.replace(suffix, '/replicate/v1')
}

/**
 * What is sent to the cutout model: the file as it is, after recraft's limits are checked on its header (nothing is
 * decoded for a size a crafted header can inflate). Only a JPEG with an EXIF rotation is re-encoded (as a JPEG, size-capped
 * and pixel-capped), so the model sees the picture upright; the limit on bytes applies to what is sent.
 */
async function prepareInput(source: { bytes: Uint8Array; format: 'png' | 'jpeg' | 'webp' }, path: string) {
  const header = readHeader(source.bytes)
  if (!header) throw fail('INVALID_INPUT', `unreadable image: ${path}`)
  const { width, height } = displayedSize(header)
  if (Math.min(width, height) < CUTOUT_LIMITS.minEdge) {
    throw fail(
      'INVALID_INPUT',
      `image sides must be at least ${CUTOUT_LIMITS.minEdge}px for cutout, got ${width}x${height}`,
    )
  }
  if (Math.max(width, height) > CUTOUT_LIMITS.maxEdge) {
    throw fail(
      'INVALID_INPUT',
      `image sides must be at most ${CUTOUT_LIMITS.maxEdge}px for cutout, got ${width}x${height}`,
    )
  }
  if (width * height > CUTOUT_LIMITS.maxPixels) {
    throw fail(
      'INVALID_INPUT',
      `image must be at most ${CUTOUT_LIMITS.maxPixels} pixels for cutout, got ${width}x${height}`,
    )
  }
  if (header.orientation === 1) return { bytes: source.bytes, mime: MIME[source.format] }
  let upright: Uint8Array
  try {
    upright = await new Bun.Image(source.bytes, { maxPixels: CUTOUT_LIMITS.maxPixels }).jpeg({ quality: 95 }).bytes()
  } catch (error) {
    throw fail('INVALID_INPUT', `unreadable image: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (upright.byteLength > CUTOUT_LIMITS.maxImageBytes) {
    throw fail(
      'INVALID_INPUT',
      `image is ${upright.byteLength} bytes after its EXIF rotation was applied, over the ${CUTOUT_LIMITS.maxImageBytes} byte limit for cutout`,
    )
  }
  return { bytes: upright, mime: MIME.jpeg }
}

export function createCutout(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.cutout',
    summary: 'Remove the background of an image (Replicate); returns an RGBA PNG and what the call cost',
    input: cutoutInput,
    output: cutoutOutput,
    // Hidden from the CLI: a result that is megabytes of base64 is for workflows (`agw image --file`), not a terminal.
    // The workflow is the command `agw image`, and the host refuses a command that is the prefix of another: the capabilities'
    // commands are single hyphenated words.
    cli: { command: ['image-cutout'], hidden: true, defaultFormat: 'json' },
    async handler(input, ctx) {
      const route = deps.route(`image.cutout.${input.model}` satisfies ImageRouteId)
      const env = deps.env()
      const config = iuConfig(env)
      const base = replicateBase(config.openaiBase, env.REPLICATE_BASE_URL)
      const source = await readInputImage(input.file, CUTOUT_LIMITS.maxImageBytes)
      const sent = await prepareInput(source, input.file)
      const headers = { authorization: `Bearer ${config.apiKey}` }
      const started = performance.now()

      const parse = (json: unknown, wire: string): Prediction => {
        const checked = prediction.safeParse(json)
        if (!checked.success) throw fail('UPSTREAM_ERROR', `${wire} answered with a body that does not fit`, {})
        return checked.data
      }
      // The create POST starts and bills a prediction. Once it may have landed it is not sent again: only a refused
      // connection, or a 429 (throttled before anything started), repeats it. A dropped or garbled answer is an error that
      // says the prediction may have started.
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
              body: JSON.stringify({
                input: { image: `data:${sent.mime};base64,${Buffer.from(sent.bytes).toString('base64')}` },
              }),
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

      let current = created
      if (running(current.status)) {
        const id = current.id
        if (!id) throw fail('UPSTREAM_ERROR', 'replicate prediction has no id to poll', {})
        const deadline = Date.now() + POLL_DEADLINE_MS
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
      }
      if (current.status !== 'succeeded') {
        throw fail('UPSTREAM_ERROR', `replicate prediction ${current.status}: ${current.error ?? 'unknown error'}`, {})
      }

      const url = Array.isArray(current.output) ? current.output[0] : current.output
      if (!url) throw fail('UPSTREAM_ERROR', 'replicate prediction succeeded with no output URL', {})
      if (!isReplicateDeliveryUrl(url))
        throw fail('UPSTREAM_ERROR', 'replicate output URL is not a replicate.delivery URL', {})
      // A redirect would leave the allowlisted host: it is an error, not something to follow.
      const delivered = await deps.fetch(url, { redirect: 'manual', signal: within(ctx.signal, DELIVERY_TIMEOUT_MS) })
      if (!delivered.ok) throw fail('UPSTREAM_ERROR', `replicate output could not be fetched (${delivered.status})`, {})
      const raw = await readBytes(delivered, MAX_DELIVERY_BYTES)
      if (!raw) throw fail('UPSTREAM_ERROR', `replicate output is over ${MAX_DELIVERY_BYTES} bytes`, {})
      // recraft delivers RGBA WebP, bria PNG: every caller gets the PNG this capability promises. The header is read first,
      // so a delivery that claims a huge canvas is refused before anything decodes for it.
      const header = readHeader(raw)
      if (!header || (header.format !== 'png' && header.format !== 'webp')) {
        throw fail('UPSTREAM_ERROR', 'replicate output is neither png nor webp (bad magic bytes or header)', {})
      }
      if (header.width * header.height > MAX_DELIVERY_PIXELS) {
        throw fail(
          'UPSTREAM_ERROR',
          `replicate output claims ${header.width}x${header.height} pixels, over the bound`,
          {},
        )
      }
      const out = await toPng(raw)
      const info = readPng(out)
      if (!info) throw fail('UPSTREAM_ERROR', 'replicate output could not be converted to a png', {})
      return {
        id: crypto.randomUUID(),
        model: route.model,
        image: { b64: Buffer.from(out).toString('base64'), bytes: out.length, ...info },
        cost,
        latencyMs: Math.round(performance.now() - started),
      }
    },
  })
}
