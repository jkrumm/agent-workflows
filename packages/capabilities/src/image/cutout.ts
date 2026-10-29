import { type ImageRouteId, priceCall } from '@agent-workflows/routes'
import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { iuConfig } from '../transports/config.ts'
import { readJson, withRetries } from '../transports/http.ts'
import { within } from '../web/deps.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { readInputImage } from './files.ts'
import { magicBytesValid, readPng, toPng } from './png.ts'
import { failedImageResponse } from './upstream.ts'

/** recraft's documented input limits (image-gateway `CUTOUT_LIMITS`), enforced for both models so the contract is uniform. */
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

interface Prediction {
  id?: string
  status: string
  output?: string | string[] | null
  error?: string | null
}

const running = (status: string) => status === 'starting' || status === 'processing'

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
 * The PNG the cutout models are sent, with recraft's limits enforced so a violation is a clear error and not an opaque
 * upstream failure. A PNG passes through byte for byte; a JPEG or WebP is re-encoded (EXIF orientation applied).
 */
async function prepareInput(bytes: Uint8Array, path: string): Promise<Uint8Array> {
  let png: Uint8Array
  try {
    png = await toPng(bytes)
  } catch (error) {
    throw fail('INVALID_INPUT', `unreadable image: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
  const info = readPng(png)
  if (!info) throw fail('INVALID_INPUT', `unreadable image: ${path}`)
  const { width, height } = info
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
  if (png.byteLength > CUTOUT_LIMITS.maxImageBytes) {
    throw fail('INVALID_INPUT', `image must be at most ${CUTOUT_LIMITS.maxImageBytes} bytes as a png for cutout`)
  }
  return png
}

export function createCutout(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.cutout',
    summary: 'Remove the background of an image (Replicate); returns an RGBA PNG and what the call cost',
    input: cutoutInput,
    output: cutoutOutput,
    cli: { positional: ['file'], defaultFormat: 'json' },
    async handler(input, ctx) {
      const route = deps.route(`image.cutout.${input.model}` satisfies ImageRouteId)
      const env = deps.env()
      const base = replicateBase(iuConfig(env).openaiBase, env.REPLICATE_BASE_URL)
      const source = await readInputImage(input.file, CUTOUT_LIMITS.maxImageBytes)
      const png = await prepareInput(source.bytes, input.file)
      const headers = { authorization: `Bearer ${iuConfig(env).apiKey}` }
      const started = performance.now()

      const created = await withRetries(deps.retry, ctx.signal, async () => {
        const res = await deps.fetch(`${base}/models/${route.model}/predictions`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', prefer: 'wait' },
          body: JSON.stringify({ input: { image: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } }),
          signal: within(ctx.signal, CREATE_TIMEOUT_MS),
        })
        if (!res.ok) throw await failedImageResponse(res, 'replicate')
        return (await readJson(res, 'replicate')) as Prediction
      })

      let prediction = created
      if (running(prediction.status)) {
        if (!prediction.id) throw fail('UPSTREAM_ERROR', 'replicate prediction has no id to poll', {})
        const deadline = Date.now() + POLL_DEADLINE_MS
        while (running(prediction.status)) {
          if (Date.now() >= deadline)
            throw fail('UPSTREAM_ERROR', `replicate prediction ${prediction.id} timed out`, {})
          await new Promise((resolve) => setTimeout(resolve, deps.pollMs))
          ctx.signal.throwIfAborted()
          // The flat path keyed by id, never the `urls.get` the API returns (that points at the public Replicate host).
          const res = await deps.fetch(`${base}/predictions/${prediction.id}`, {
            headers,
            signal: within(ctx.signal, DELIVERY_TIMEOUT_MS),
          })
          if (!res.ok) throw await failedImageResponse(res, 'replicate poll')
          prediction = (await readJson(res, 'replicate poll')) as Prediction
        }
      }
      if (prediction.status !== 'succeeded') {
        throw fail(
          'UPSTREAM_ERROR',
          `replicate prediction ${prediction.status}: ${prediction.error ?? 'unknown error'}`,
          {},
        )
      }

      // A succeeded prediction is billed, whether or not its output can be fetched.
      const cost = priceCall(route.price, null)
      ctx.addUsage({
        model: route.model,
        tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
        cost: cost.usd,
        costSource: cost.source,
      })

      const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
      if (!url) throw fail('UPSTREAM_ERROR', 'replicate prediction succeeded with no output URL', {})
      if (!isReplicateDeliveryUrl(url))
        throw fail('UPSTREAM_ERROR', 'replicate output URL is not a replicate.delivery URL', {})
      const delivered = await deps.fetch(url, { signal: within(ctx.signal, DELIVERY_TIMEOUT_MS) })
      if (!delivered.ok) throw fail('UPSTREAM_ERROR', `replicate output could not be fetched (${delivered.status})`, {})
      // recraft delivers RGBA WebP, bria PNG: every caller gets the PNG this capability promises.
      const raw = new Uint8Array(await delivered.arrayBuffer())
      if (!magicBytesValid(raw, 'png') && !magicBytesValid(raw, 'webp')) {
        throw fail('UPSTREAM_ERROR', 'replicate output is neither png nor webp (bad magic bytes)', {})
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
