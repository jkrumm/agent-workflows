// Reading and checking a door request: the body bounded, JSON or multipart parsed, the studio's schemas applied, the
// edit endpoint's file rules checked in the studio's order and wording. Every refusal is a `RequestError` the door
// answers with the studio's error envelope; nothing here reaches upstream.
import type { ImageFile } from '@agent-workflows/capabilities'
import type { z } from 'zod'
import { EDIT_LIMITS, INPUT_IMAGE_MIME_TYPES, editRequestSchema } from './contract.ts'

/**
 * The most a JSON request carries: a prompt is 32 000 characters, a plan request adds a style guide and a series of
 * prior prompts. Far above any real one.
 */
export const MAX_JSON_BYTES = 2 * 1024 * 1024
/**
 * The most a multipart edit carries in total: two full-size references (the per-file limit is 50 MB, 16 files, which
 * would be 800 MB). Below Bun's own cap for the whole server (`MAX_REQUEST_BODY_BYTES`, 128 MiB, shared with every route),
 * so a request over it is answered here with the studio's envelope instead of Bun's bare 413. Peak memory at the limit
 * is at most four copies of it in flight, by construction (not measured): the received chunks, the joined body, the parsed
 * files, and the references' bytes rebuilt into the upstream form; the earlier ones are released as the later ones are
 * built, and at most `MAX_IN_FLIGHT` requests are in flight at once.
 */
export const MAX_MULTIPART_BYTES = 100 * 1024 * 1024
/** How long a request body may take to arrive in all (wall clock): a client that trickles an upload is not held forever. */
export const UPLOAD_DEADLINE_MS = 5 * 60_000

/** A request the door refuses before any work; `status` is 400, 408 or 413. */
export class RequestError extends Error {
  constructor(
    readonly status: 400 | 408 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

const tooLarge = (max: number) => new RequestError(413, `request body is over ${max} bytes`)

/**
 * The body, read only while it stays within `max` bytes and `deadlineMs` of wall clock: a declared length over the cap is
 * refused without reading, a body still arriving at the deadline is a 408. Kept as a `Blob` of the received chunks, so
 * nothing joins them into one more contiguous copy.
 */
export async function readBounded(request: Request, max: number, deadlineMs = UPLOAD_DEADLINE_MS): Promise<Blob> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await request.body?.cancel().catch(() => undefined)
    throw tooLarge(max)
  }
  const reader = request.body?.getReader()
  if (!reader) return new Blob([])
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestError(408, 'the request body was not received in time')), deadlineMs)
  })
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late])
      if (done) break
      total += value.length
      if (total > max) throw tooLarge(max)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof RequestError) throw error
    throw new RequestError(400, 'the request body could not be read')
  } finally {
    clearTimeout(timer)
  }
  return new Blob(chunks)
}

/** The studio's way of wording a schema failure: the issues' messages, joined. */
const messageOf = (error: z.ZodError) => error.issues.map((issue) => issue.message).join('; ')

/** The body as JSON through a schema; a body that is not JSON, or does not fit, is a 400. */
export async function parseJson<S extends z.ZodType>(body: Blob, schema: S): Promise<z.output<S>> {
  let json: unknown
  try {
    json = JSON.parse(await body.text())
  } catch {
    throw new RequestError(400, 'the request body is not valid JSON')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new RequestError(400, messageOf(parsed.error))
  return parsed.data
}

const imageFile = (file: File, bytes: Uint8Array<ArrayBuffer>): ImageFile => ({
  bytes,
  name: file.name,
  mime: file.type,
})

export interface EditUpload {
  fields: z.output<typeof editRequestSchema>
  references: ImageFile[]
  mask: ImageFile | undefined
}

const FILE_FIELDS = new Set(['image[]', 'image', 'mask'])

/** The multipart edit request: its non-file fields through the schema, its `image[]`/`image` parts as references, an optional `mask`. */
export async function parseEdit(body: Blob, contentType: string | null): Promise<EditUpload> {
  let form: FormData
  try {
    form = await new Response(body, { headers: contentType ? { 'content-type': contentType } : {} }).formData()
  } catch {
    throw new RequestError(400, 'the multipart body could not be parsed')
  }
  const files = [...form.getAll('image[]'), ...form.getAll('image')].filter(
    (part): part is File => part instanceof File,
  )
  const maskPart = form.get('mask')
  const mask = maskPart instanceof File ? maskPart : undefined

  if (files.length === 0) throw new RequestError(400, 'at least one reference image is required')
  if (files.length > EDIT_LIMITS.maxImages) {
    throw new RequestError(400, `at most ${EDIT_LIMITS.maxImages} reference images are allowed`)
  }
  for (const file of files) {
    if (file.size > EDIT_LIMITS.maxImageBytes) {
      throw new RequestError(400, `each reference image must be at most ${EDIT_LIMITS.maxImageBytes} bytes`)
    }
    if (!(INPUT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      throw new RequestError(400, `reference images must be one of: ${INPUT_IMAGE_MIME_TYPES.join(', ')}`)
    }
  }
  if (mask !== undefined) {
    if (mask.size > EDIT_LIMITS.maxMaskBytes) {
      throw new RequestError(400, `mask must be at most ${EDIT_LIMITS.maxMaskBytes} bytes`)
    }
    if (mask.type !== 'image/png') throw new RequestError(400, 'mask must be image/png (needs an alpha channel)')
  }

  const raw: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (FILE_FIELDS.has(key) || typeof value !== 'string') continue
    raw[key] = value
  }
  const parsed = editRequestSchema.safeParse(raw)
  if (!parsed.success) throw new RequestError(400, messageOf(parsed.error))

  const references = await Promise.all(
    files.map(async (file) => imageFile(file, new Uint8Array(await file.arrayBuffer()))),
  )
  return {
    fields: parsed.data,
    references,
    mask: mask ? imageFile(mask, new Uint8Array(await mask.arrayBuffer())) : undefined,
  }
}
