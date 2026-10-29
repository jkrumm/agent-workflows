import type { ImageRouteId } from '@agent-workflows/routes'
import { priceCall } from '@agent-workflows/routes'
import { z } from 'zod'
import type { Usage } from '../context.ts'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { iuConfig } from '../transports/config.ts'
import { readJson, withRetries } from '../transports/http.ts'
import { within } from '../web/deps.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { MAX_EDIT_IMAGE_BYTES, MAX_EDIT_IMAGES, readInputImage } from './files.ts'
import { magicBytesValid, MIME, readPng } from './png.ts'
import { snapSize } from './size.ts'
import { failedImageResponse } from './upstream.ts'

export const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const
export const MODELS = ['auto', 'flare', 'sunburst'] as const

export const generateInput = z.object({
  prompt: z.string().min(1).max(32_000).describe('What to draw, or with images, what to change'),
  size: z
    .string()
    .regex(/^(auto|\d{2,4}x\d{2,4})$/, "size must be 'auto' or 'WxH'")
    .default('auto')
    .describe(
      "'auto', a preset (1024x1024, 1536x1024, 1024x1536) or WxH; a WxH outside the endpoint's envelope is snapped into it",
    ),
  n: z.int().min(1).max(10).default(1).describe('Images to generate, 1-10'),
  quality: z
    .enum(QUALITIES)
    .default('auto')
    .describe('low is about a tenth of the price of high; xhigh and max cost far more'),
  model: z
    .enum(MODELS)
    .default('auto')
    .describe(
      'flare: fast, for drafts. sunburst: slower, for final renders and edits. auto: sunburst for high, xhigh, max and every edit, else flare',
    ),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .default('auto')
    .describe('transparent returns a PNG with an alpha channel; the prompt must not ask for a checkerboard'),
  images: z
    .array(z.string().min(1))
    .max(MAX_EDIT_IMAGES)
    .default([])
    .describe(
      'Absolute paths of reference images on this host (png, jpeg, webp; 50 MB each, at most 16): the call becomes an edit',
    ),
})

const image = z.object({
  b64: z.string().describe('The PNG, base64'),
  bytes: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasAlpha: z.boolean().describe('The PNG has an alpha channel (not that a pixel is transparent)'),
})
export type GeneratedImage = z.infer<typeof image>

export const generateOutput = z.object({
  id: z.string().describe('The generation id'),
  model: z.string(),
  size: z.string().describe('The size requested after snapping; each image carries the size it came back as'),
  snappedFrom: z.string().optional().describe('The size asked for, when it was snapped'),
  quality: z.string(),
  background: z.string(),
  edit: z.boolean(),
  images: z.array(image),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type GenerateOutput = z.infer<typeof generateOutput>

const upstreamResponse = z.object({
  data: z.array(z.object({ b64_json: z.string() })),
  usage: z
    .object({
      cost: z.number().nullish(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      input_tokens_details: z
        .object({ text_tokens: z.number().nullish(), image_tokens: z.number().nullish() })
        .nullish(),
    })
    .nullish(),
})

const REQUEST_TIMEOUT_MS = 180_000
const HIGH_QUALITY = new Set<string>(['high', 'xhigh', 'max'])

/** The seat for a request: an explicit model wins; `auto` is image-gateway's rule (an edit and a final-quality render go to the quality model). */
export function pickRoute(
  model: (typeof MODELS)[number],
  quality: (typeof QUALITIES)[number],
  edit: boolean,
): ImageRouteId {
  if (model === 'flare') return 'image.flare'
  if (model === 'sunburst') return 'image.sunburst'
  return edit || HIGH_QUALITY.has(quality) ? 'image.sunburst' : 'image.flare'
}

export function createGenerate(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.generate',
    summary: 'Generate images from a prompt, or edit reference images; returns the PNGs and what the call cost',
    input: generateInput,
    output: generateOutput,
    cli: { positional: ['prompt'], defaultFormat: 'json' },
    async handler(input, ctx) {
      const edit = input.images.length > 0
      const route = deps.route(pickRoute(input.model, input.quality, edit))
      const config = iuConfig(deps.env())
      const size = snapSize(input.size)
      const references = await Promise.all(input.images.map((path) => readInputImage(path, MAX_EDIT_IMAGE_BYTES)))

      const fields = {
        model: route.model,
        prompt: input.prompt,
        n: input.n,
        size,
        quality: input.quality,
        background: input.background,
        output_format: 'png',
      }
      // Multiple references use the repeated `image[]` field (verified with 2), exactly one the plain `image` field.
      const body = (): { body: BodyInit; headers: Record<string, string> } => {
        if (!edit) return { body: JSON.stringify(fields), headers: { 'content-type': 'application/json' } }
        const form = new FormData()
        for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
        const field = references.length > 1 ? 'image[]' : 'image'
        for (const ref of references) {
          const name = ref.path.slice(ref.path.lastIndexOf('/') + 1)
          form.append(field, new File([ref.bytes], name, { type: MIME[ref.format] }))
        }
        return { body: form, headers: {} }
      }
      const url = `${config.openaiBase}/${edit ? 'images/edits' : 'images/generations'}`

      const started = performance.now()
      const json = await withRetries(deps.retry, ctx.signal, async () => {
        const { body: payload, headers } = body()
        const res = await deps.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, ...headers },
          body: payload,
          signal: within(ctx.signal, REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) throw await failedImageResponse(res, 'image')
        return readJson(res, 'image')
      })
      const parsed = upstreamResponse.safeParse(json)
      if (!parsed.success) throw fail('UPSTREAM_ERROR', 'image answered with a body that does not fit', {})
      const { data, usage } = parsed.data

      // The call is billed from here on, whatever the images turn out to be.
      const cost = priceCall(route.price, usage)
      const reported: Usage = {
        model: route.model,
        tokens: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0, cacheRead: 0, reasoning: 0 },
        cost: cost.usd,
        costSource: cost.source,
      }
      ctx.addUsage(reported)

      if (data.length === 0) throw fail('UPSTREAM_ERROR', 'image returned no images', {})
      const images = data.map((entry, index) => {
        const bytes = Buffer.from(entry.b64_json, 'base64')
        const info = magicBytesValid(bytes, 'png') ? readPng(bytes) : null
        if (!info) throw fail('UPSTREAM_ERROR', `image ${index + 1} is not a valid png (bad magic bytes)`, {})
        return { b64: entry.b64_json, bytes: bytes.length, ...info }
      })
      return {
        id: crypto.randomUUID(),
        model: route.model,
        size,
        ...(size !== input.size ? { snappedFrom: input.size } : {}),
        quality: input.quality,
        background: input.background,
        edit,
        images,
        cost,
        latencyMs: Math.round(performance.now() - started),
      }
    },
  })
}
