import { type Cost, costFromUsage } from '@agent-workflows/routes'
import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { iuConfig } from '../transports/config.ts'
import { Attempt } from '../transports/http.ts'
import { within } from '../web/deps.ts'
import type { ImageRouteId, ResolvedImageDeps } from './deps.ts'
import { MAX_EDIT_IMAGE_BYTES, MAX_EDIT_IMAGES } from './files.ts'
import { magicBytesValid } from './png.ts'
import { validateSize } from './size.ts'
import { readJsonBounded, send } from './wire.ts'

// The vocabulary of the image endpoints, shared by `image.generate`, `image.enhance` and the studio door.
export const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const
export const GENERATE_MODELS = ['flare', 'sunburst'] as const
export const MODELS = ['auto', ...GENERATE_MODELS] as const
export const OUTPUT_FORMATS = ['png', 'webp', 'jpeg'] as const
export const MODERATIONS = ['auto', 'low'] as const
export const INPUT_FIDELITIES = ['high', 'low'] as const
export const BACKGROUNDS = ['transparent', 'opaque', 'auto'] as const
/** `partial_images` the endpoint takes: preview frames before the final image. */
export const MAX_PARTIAL_IMAGES = 3

export type Quality = (typeof QUALITIES)[number]
export type ImageModelChoice = (typeof MODELS)[number]
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]
export type Moderation = (typeof MODERATIONS)[number]
export type InputFidelity = (typeof INPUT_FIDELITIES)[number]
export type Background = (typeof BACKGROUNDS)[number]
export type GenerateSeat = 'image.flare' | 'image.sunburst'

/**
 * What each generation model accepts that the endpoint rejects outright otherwise (image-gateway `MODEL_CAPABILITIES`,
 * probe-verified): gpt-image-2.5 answers `input_fidelity` with a 400 "Unknown parameter", so the parameter is refused
 * here rather than sent or silently dropped. Keyed by seat, because the route table decides which model sits on it.
 */
export const MODEL_CAPABILITIES: Record<GenerateSeat, { inputFidelity: boolean }> = {
  'image.flare': { inputFidelity: false },
  'image.sunburst': { inputFidelity: false },
}

/** Upstream limit of the mask (image-gateway `EDIT_LIMITS.maxMaskBytes`). */
export const MAX_MASK_BYTES = 4 * 1024 * 1024
const INPUT_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']
const HIGH_QUALITY = new Set<string>(['high', 'xhigh', 'max'])

/** The seat for a request: an explicit model wins; `auto` is image-gateway's rule (an edit and a final-quality render go to the quality model, the rest to the speed model). */
export function pickRoute(model: ImageModelChoice, quality: Quality, edit: boolean): GenerateSeat {
  if (model === 'flare') return 'image.flare'
  if (model === 'sunburst') return 'image.sunburst'
  return edit || HIGH_QUALITY.has(quality) ? 'image.sunburst' : 'image.flare'
}

/** Why `auto` picked what it picked, without the model name (image-gateway `autoRoutingWhy`). */
export function routingWhy(edit: boolean, quality: Quality): string {
  if (edit) return 'editing/reference precision'
  return HIGH_QUALITY.has(quality)
    ? `a ${quality}-quality final render`
    : `a ${quality === 'auto' ? 'default' : quality}-quality draft`
}

const REQUEST_TIMEOUT_MS = 180_000
/** One generated image, decoded: gpt-image answers at most ~3839 px a side; an entry over this is not an image we keep. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_B64 = Math.ceil((MAX_IMAGE_BYTES * 4) / 3)
/** The whole answer, whatever n. */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024
/** One SSE frame buffered: a final image (the largest frame) and its envelope. */
const MAX_FRAME_CHARS = MAX_IMAGE_B64 + 1024 * 1024

/** A file of a request: the bytes, the name the endpoint sees, and the declared mime type. */
export interface ImageFile {
  bytes: Uint8Array<ArrayBuffer>
  name: string
  mime: string
}

/** One preview frame: the encoded image as the endpoint sent it, its format, and the endpoint's own 0-based counter. */
export interface ImagePartial {
  b64: string
  format: OutputFormat
  index: number
}

/**
 * One call to the images API. Field names follow the studio's wire contract (`output_format`, `input_fidelity`,
 * `partial_images`), so a validated studio request can be spread into it.
 */
export interface ImageRequest {
  prompt: string
  /** `auto`, a preset or `WxH` inside the envelope (`validateSize`); not snapped here. Default `auto`. */
  size?: string
  /** 1-10. Default 1. */
  n?: number
  quality?: Quality
  model?: ImageModelChoice
  background?: Background
  /** Default `png`. */
  output_format?: OutputFormat
  /** 0-100, for jpeg and webp. Sent only when set. */
  output_compression?: number
  /** Sent only when set. */
  moderation?: Moderation
  /** Edits only, and only on a model that takes it (`MODEL_CAPABILITIES`): refused otherwise. Sent only when set. */
  input_fidelity?: InputFidelity
  /** 0 (default) is one JSON answer; 1-3 streams that many previews and needs `n` 1. */
  partial_images?: number
  /** None: `/images/generations`. One or more (at most 16, 50 MB each, png/jpeg/webp): `/images/edits`. */
  references?: ImageFile[]
  /** An alpha PNG, at most 4 MB; edits only. */
  mask?: ImageFile
  /** Called for each preview, in the order they arrive and awaited; a throw ends the call. */
  onPartial?: (partial: ImagePartial) => void | Promise<void>
}

export interface ImageResultImage {
  /** Position in the endpoint's answer (rejected entries leave gaps). */
  index: number
  b64: string
  format: OutputFormat
}

export interface ImageUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number }
  output_tokens_details?: Record<string, number>
}

export interface ImageResult {
  id: string
  /** Unix seconds: the endpoint's own, else now. */
  created: number
  /** The model that served it: the route table's id of the seat. */
  model: string
  /** What the request named, verbatim. */
  requestedModel: ImageModelChoice
  /** True when `auto` chose the model; `routingReason` says why. */
  routed: boolean
  routingReason?: string
  edit: boolean
  /** The entries that are the format they claim to be, in order; at least one. */
  images: ImageResultImage[]
  /** Entries of the answer that were billed and not kept. */
  rejected: { index: number; reason: string }[]
  /** As the endpoint answered, else as requested. */
  size: string
  quality: string
  background: string
  /** The endpoint's own counts, zeros when it sent none (the cost is then `unknown`, never 0). */
  usage: ImageUsage
  cost: Cost
  latencyMs: number
}

const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

const upstreamUsage = z
  .object({
    cost: z.number().nullish(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: lenient(z.number()),
    input_tokens_details: z
      .object({
        text_tokens: z.number().nullish(),
        image_tokens: z.number().nullish(),
        cached_tokens: z.number().nullish(),
      })
      .nullish(),
    output_tokens_details: z.record(z.string(), z.number()).nullish().catch(undefined),
  })
  .nullish()
type UpstreamUsage = z.infer<typeof upstreamUsage>

const upstreamResponse = z.object({
  created: lenient(z.number()),
  data: z.array(z.object({ b64_json: z.string() })),
  usage: upstreamUsage,
  size: lenient(z.string()),
  quality: lenient(z.string()),
  background: lenient(z.string()),
})

/** What the answer carries, whichever way it arrived. */
interface Answer {
  entries: string[]
  format: OutputFormat
  created?: number
  usage: UpstreamUsage
  size?: string
  quality?: string
  background?: string
}

const completedFrame = z.object({
  b64_json: z.string(),
  output_format: lenient(z.string()),
  created_at: lenient(z.number()),
  usage: upstreamUsage,
  size: lenient(z.string()),
  quality: lenient(z.string()),
  background: lenient(z.string()),
})

const asFormat = (value: unknown): OutputFormat | undefined =>
  (OUTPUT_FORMATS as readonly unknown[]).includes(value) ? (value as OutputFormat) : undefined

function invalid(message: string): never {
  throw fail('INVALID_INPUT', message)
}

/** The request's own rules, all before anything is sent. */
function validate(request: ImageRequest, seat: GenerateSeat, edit: boolean): void {
  const { n = 1, partial_images: partials = 0, references = [], mask, input_fidelity: fidelity } = request
  if (partials > 0 && n > 1) invalid('streaming (partial_images > 0) is only supported with n=1')
  if (!Number.isInteger(partials) || partials < 0 || partials > MAX_PARTIAL_IMAGES) {
    invalid(`partial_images must be an integer 0-${MAX_PARTIAL_IMAGES}`)
  }
  const compression = request.output_compression
  if (compression !== undefined && (!Number.isInteger(compression) || compression < 0 || compression > 100)) {
    invalid('output_compression must be an integer 0-100')
  }
  const sizeError = validateSize(request.size ?? 'auto')
  if (sizeError) invalid(sizeError)
  if ((request.background ?? 'auto') === 'transparent' && request.output_format === 'jpeg') {
    invalid('a transparent background needs png or webp output, jpeg has no alpha channel')
  }
  if (fidelity !== undefined) {
    if (!edit) invalid('input_fidelity applies to edits only (no reference images were given)')
    if (!MODEL_CAPABILITIES[seat].inputFidelity) invalid(`${seat} does not support input_fidelity (it is always high)`)
  }
  if (references.length > MAX_EDIT_IMAGES) invalid(`at most ${MAX_EDIT_IMAGES} reference images are allowed`)
  for (const ref of references) {
    if (ref.bytes.length > MAX_EDIT_IMAGE_BYTES) {
      invalid(`each reference image must be at most ${MAX_EDIT_IMAGE_BYTES} bytes`)
    }
    if (!INPUT_MIMES.includes(ref.mime)) invalid(`reference images must be one of: ${INPUT_MIMES.join(', ')}`)
  }
  if (mask === undefined) return
  if (!edit) invalid('a mask needs at least one reference image')
  if (mask.bytes.length > MAX_MASK_BYTES) invalid(`mask must be at most ${MAX_MASK_BYTES} bytes`)
  if (mask.mime !== 'image/png') invalid('mask must be image/png (needs an alpha channel)')
}

type Field = string | number | boolean

/** Multiple references use the repeated `image[]` field (verified with 2), exactly one the plain `image` field. */
function editBody(fields: Record<string, Field>, references: ImageFile[], mask: ImageFile | undefined): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
  const field = references.length > 1 ? 'image[]' : 'image'
  for (const ref of references) form.append(field, new File([ref.bytes], ref.name, { type: ref.mime }))
  if (mask) form.append('mask', new File([mask.bytes], mask.name, { type: mask.mime }))
  return form
}

/** Entries that are the format they claim to be and fit the per-image cap, and the ones that are not (billed all the same). */
function sortEntries(entries: string[], format: OutputFormat) {
  const images: ImageResultImage[] = []
  const rejected: { index: number; reason: string }[] = []
  entries.forEach((entry, index) => {
    if (entry.length > MAX_IMAGE_B64) {
      rejected.push({ index, reason: `over the ${MAX_IMAGE_BYTES} byte cap for one image` })
      return
    }
    if (magicBytesValid(Buffer.from(entry, 'base64'), format)) images.push({ index, b64: entry, format })
    else rejected.push({ index, reason: `not a valid ${format} (bad magic bytes)` })
  })
  return { images, rejected }
}

function upstreamErrorMessage(data: unknown): string {
  const error = (data as { error?: { message?: unknown } } | null)?.error
  if (typeof error?.message === 'string') return error.message
  return `image stream error: ${JSON.stringify(data).slice(0, 300)}`
}

/** One raw SSE block as `{ event, data }`; null when it has no payload or the payload is not JSON (skipped, not fatal). */
function parseFrame(text: string): { event: string; data: unknown } | null {
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
  }
  if (dataLines.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  // A stream that names its events only in the payload (`{"type": "image_edit.completed"}`) reads the same.
  const named = event ?? (data as { type?: unknown } | null)?.type
  return typeof named === 'string' ? { event: named, data } : null
}

/**
 * The upstream SSE stream read to its one `completed` frame. `/images/generations` names its events `image_generation.*`,
 * `/images/edits` `image_edit.*`, with the same payloads (probe-verified), so events match on the suffix. Previews go to
 * `onPartial` as they arrive; fewer than asked is normal. An error frame, a stream that ends without a completed frame and
 * a frame over the buffer bound each throw: the stream ends in exactly one completed frame or one error, never silently.
 */
async function readStream(
  res: Response,
  requested: OutputFormat,
  onChunk: () => void,
  onPartial: ImageRequest['onPartial'],
): Promise<Answer> {
  if (!res.body) throw fail('UPSTREAM_ERROR', 'image answered with no stream body', {})
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let previews = 0

  const handle = async (text: string): Promise<Answer | null> => {
    const frame = parseFrame(text)
    if (!frame) return null
    if (frame.event === 'error' || frame.event.endsWith('.error')) {
      const message = upstreamErrorMessage(frame.data)
      throw new Attempt(`image stream failed: ${message}`, false, undefined, { message })
    }
    if (frame.event.endsWith('.partial_image')) {
      const data = frame.data as { b64_json?: unknown; partial_image_index?: unknown; output_format?: unknown }
      if (typeof data.b64_json !== 'string') return null
      const index = typeof data.partial_image_index === 'number' ? data.partial_image_index : previews
      previews++
      await onPartial?.({ b64: data.b64_json, format: asFormat(data.output_format) ?? requested, index })
      return null
    }
    if (!frame.event.endsWith('.completed')) return null
    const parsed = completedFrame.safeParse(frame.data)
    if (!parsed.success) throw fail('UPSTREAM_ERROR', 'image answered with a completed frame that does not fit', {})
    const { b64_json, output_format, created_at, usage, size, quality, background } = parsed.data
    return {
      entries: [b64_json],
      format: asFormat(output_format) ?? requested,
      ...(created_at !== undefined ? { created: created_at } : {}),
      usage,
      ...(size !== undefined ? { size } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(background !== undefined ? { background } : {}),
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk()
      // Only the new text can hold a separator: a scan from the start would be quadratic on a 40 MB frame.
      const from = Math.max(0, buffer.length - 1)
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r', '')
      for (let end = buffer.indexOf('\n\n', from); end !== -1; end = buffer.indexOf('\n\n')) {
        if (end > MAX_FRAME_CHARS)
          throw fail('UPSTREAM_ERROR', `image stream frame is over ${MAX_FRAME_CHARS} bytes`, {})
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const answer = await handle(text)
        if (answer) return answer
      }
      if (buffer.length > MAX_FRAME_CHARS) {
        throw fail('UPSTREAM_ERROR', `image stream frame is over ${MAX_FRAME_CHARS} bytes`, {})
      }
    }
    // A stream that ends without a trailing blank line still delivers its last frame.
    const answer = buffer.trim() ? await handle(buffer) : null
    if (answer) return answer
    throw fail('UPSTREAM_ERROR', 'image stream ended without a completed frame', {})
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * Generate or edit images over the IU images API: the one upstream implementation behind `image.generate` and the studio
 * door. No references is `/images/generations` (JSON); one or more is `/images/edits` (multipart, `image` for one file,
 * `image[]` for several, optional `mask`). `partial_images` above 0 sends `stream: true` and reads the SSE answer, calling
 * `onPartial` per preview.
 *
 * The request may have landed and been billed by the time anything goes wrong, so only an error status the endpoint
 * answered with (image-gateway's retry set), or a refused connection, is sent again; never a dropped or garbled 200, and
 * never a stream that has begun. The billed call is reported to `ctx.addUsage` as soon as its usage is known, whatever the
 * images turn out to be. A stream is aborted after `deps.streamIdleMs` without a byte (a hang guard, never a budget).
 */
export async function requestImages(
  deps: ResolvedImageDeps,
  ctx: Pick<Ctx, 'addUsage' | 'signal'>,
  request: ImageRequest,
): Promise<ImageResult> {
  const references = request.references ?? []
  const edit = references.length > 0
  const model = request.model ?? 'auto'
  const quality = request.quality ?? 'auto'
  const n = request.n ?? 1
  const size = request.size ?? 'auto'
  const background = request.background ?? 'auto'
  const format = request.output_format ?? 'png'
  const partials = request.partial_images ?? 0
  const streaming = partials > 0

  const seat = pickRoute(model, quality, edit)
  validate(request, seat, edit)
  const route = deps.route(seat)
  const config = iuConfig(deps.env())

  const fields: Record<string, Field> = {
    model: route.model,
    prompt: request.prompt,
    n,
    size,
    quality,
    background,
    output_format: format,
    ...(request.output_compression !== undefined ? { output_compression: request.output_compression } : {}),
    ...(request.moderation !== undefined ? { moderation: request.moderation } : {}),
    ...(request.input_fidelity !== undefined ? { input_fidelity: request.input_fidelity } : {}),
    ...(streaming ? { stream: true, partial_images: partials } : {}),
  }
  const url = `${config.openaiBase}/${edit ? 'images/edits' : 'images/generations'}`
  const body = (): { body: BodyInit; headers: Record<string, string> } =>
    edit
      ? { body: editBody(fields, references, request.mask), headers: {} }
      : { body: JSON.stringify(fields), headers: { 'content-type': 'application/json' } }

  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(), deps.streamIdleMs)
  }

  const started = performance.now()
  let answer: Answer
  try {
    answer = await send({
      retry: deps.retry,
      signal: ctx.signal,
      wire: 'image',
      idempotent: false,
      status: () => true,
      request: () => {
        const { body: payload, headers } = body()
        if (streaming) arm()
        return deps.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, ...headers },
          body: payload,
          redirect: 'error',
          signal: streaming ? AbortSignal.any([ctx.signal, idle.signal]) : within(ctx.signal, REQUEST_TIMEOUT_MS),
        })
      },
      read: streaming
        ? (res) => readStream(res, format, arm, request.onPartial)
        : async (res) => {
            const json = await readJsonBounded(
              res,
              'image',
              Math.min(MAX_RESPONSE_BYTES, n * MAX_IMAGE_B64 + 1024 * 1024),
              false,
            )
            const parsed = upstreamResponse.safeParse(json)
            if (!parsed.success) throw fail('UPSTREAM_ERROR', 'image answered with a body that does not fit', {})
            const {
              data,
              created,
              usage,
              size: answeredSize,
              quality: answeredQuality,
              background: answeredBg,
            } = parsed.data
            return {
              entries: data.map((entry) => entry.b64_json),
              format,
              usage,
              ...(created !== undefined ? { created } : {}),
              ...(answeredSize !== undefined ? { size: answeredSize } : {}),
              ...(answeredQuality !== undefined ? { quality: answeredQuality } : {}),
              ...(answeredBg !== undefined ? { background: answeredBg } : {}),
            }
          },
    })
  } catch (error) {
    if (idle.signal.aborted && !ctx.signal.aborted) {
      throw fail('UPSTREAM_ERROR', `image stream idle for ${deps.streamIdleMs}ms with no data`, {})
    }
    throw error
  } finally {
    clearTimeout(timer)
  }

  // The call is billed from here on, whatever the images turn out to be.
  const { usage } = answer
  const cost = costFromUsage(route.wire, usage, route.rate, route.price)
  ctx.addUsage({
    model: route.model,
    tokens: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0, cacheRead: 0, reasoning: 0 },
    cost: cost.usd,
    costSource: cost.source,
  })

  if (answer.entries.length === 0) throw fail('UPSTREAM_ERROR', 'image returned no images', {})
  // One bad entry among n does not discard the valid, already billed ones: they are returned, the bad one reported.
  const { images, rejected } = sortEntries(answer.entries, answer.format)
  if (images.length === 0) {
    throw fail(
      'UPSTREAM_ERROR',
      `image returned no valid ${answer.format}: ${rejected.map((r) => `#${r.index + 1} ${r.reason}`).join('; ')}`,
      {},
    )
  }

  const input = usage?.input_tokens ?? 0
  const output = usage?.output_tokens ?? 0
  const details = usage?.input_tokens_details
  const inputDetails = {
    ...(typeof details?.text_tokens === 'number' ? { text_tokens: details.text_tokens } : {}),
    ...(typeof details?.image_tokens === 'number' ? { image_tokens: details.image_tokens } : {}),
    ...(typeof details?.cached_tokens === 'number' ? { cached_tokens: details.cached_tokens } : {}),
  }
  const routed = model === 'auto'
  return {
    id: crypto.randomUUID(),
    created: answer.created ?? Math.floor(Date.now() / 1000),
    model: route.model,
    requestedModel: model,
    routed,
    ...(routed ? { routingReason: `routed to ${route.model} for ${routingWhy(edit, quality)}` } : {}),
    edit,
    images,
    rejected,
    size: answer.size ?? size,
    quality: answer.quality ?? quality,
    background: answer.background ?? background,
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: usage?.total_tokens ?? input + output,
      ...(Object.keys(inputDetails).length > 0 ? { input_tokens_details: inputDetails } : {}),
      ...(usage?.output_tokens_details ? { output_tokens_details: usage.output_tokens_details } : {}),
    },
    cost,
    latencyMs: Math.round(performance.now() - started),
  }
}
