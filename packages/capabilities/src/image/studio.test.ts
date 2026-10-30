import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ROUTES as IMAGE_ROUTES } from '@agent-workflows/routes'
import type { Usage } from '../context.ts'
import { CapabilityError } from '../errors.ts'
import { resolveImageDeps } from './deps.ts'
import { type ImagePartial, type ImageRequest, requestImages } from './studio.ts'
import { b64, type FakeHandler, pngFixture, startFakeImageServer } from './testing.ts'

const fake = startFakeImageServer()
const POST_GEN = '/openai/v1/images/generations'
const POST_EDIT = '/openai/v1/images/edits'
const FLARE = IMAGE_ROUTES['image.flare'].model
const SUNBURST = IMAGE_ROUTES['image.sunburst'].model

afterAll(() => fake.stop())
beforeEach(() => fake.reset())

const png = pngFixture(8, 8)
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2])
const usage = { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }
const COST = (100 * 5 + 1000 * 30) / 1e6

const deps = (streamIdleMs?: number, streamMaxMs?: number) =>
  resolveImageDeps({
    env: { IU_API_KEY: 'test-key', IU_BASE_URL: fake.baseUrl },
    retry: { backoffMs: 0 },
    ...(streamIdleMs ? { streamIdleMs } : {}),
    ...(streamMaxMs ? { streamMaxMs } : {}),
  })

async function run(request: ImageRequest, idleMs?: number, maxMs?: number) {
  const reported: Usage[] = []
  const controller = new AbortController()
  const result = await requestImages(
    deps(idleMs, maxMs),
    { addUsage: (u) => reported.push(u), signal: controller.signal },
    request,
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  return { ...result, reported }
}
async function ok(request: ImageRequest) {
  const { value, error, reported } = await run(request)
  if (!value) throw error
  return { result: value, reported }
}
async function refused(request: ImageRequest, idleMs?: number, maxMs?: number) {
  const { error, reported } = await run(request, idleMs, maxMs)
  if (!(error instanceof CapabilityError)) throw new Error(`expected a CapabilityError, got ${String(error)}`)
  return { error, reported }
}

const file = (name: string, bytes: Uint8Array<ArrayBuffer>, mime = 'image/png') => ({ name, bytes, mime })
const refPng = file('a.png', new Uint8Array(png))
const refJpeg = file('b.jpg', new Uint8Array(jpeg), 'image/jpeg')

const sse = (events: [string, unknown][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const partial = (index: number, bytes: Uint8Array = png, ns = 'image_generation') =>
  [`${ns}.partial_image`, { type: `${ns}.partial_image`, b64_json: b64(bytes), partial_image_index: index }] as [
    string,
    unknown,
  ]
const completed = (bytes: Uint8Array = png, extra: Record<string, unknown> = {}, ns = 'image_generation') =>
  [`${ns}.completed`, { type: `${ns}.completed`, b64_json: b64(bytes), usage, ...extra }] as [string, unknown]
const stream =
  (chunks: string[]): FakeHandler =>
  () =>
    new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } })

describe('requestImages: the request', () => {
  test('no references: JSON to /images/generations; moderation and input_fidelity are omitted unless given', async () => {
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }], usage }))
    const { result, reported } = await ok({ prompt: 'a lighthouse', quality: 'low', size: '1536x1024' })

    expect(fake.seen[0]?.headers.get('authorization')).toBe('Bearer test-key')
    expect(fake.seen[0]?.json).toEqual({
      model: FLARE,
      prompt: 'a lighthouse',
      n: 1,
      size: '1536x1024',
      quality: 'low',
      background: 'auto',
      output_format: 'png',
    })
    expect(result).toMatchObject({ model: FLARE, requestedModel: 'auto', routed: true, edit: false, rejected: [] })
    expect(result.routingReason).toBe(`routed to ${FLARE} for a low-quality draft`)
    expect(result.images).toEqual([{ index: 0, b64: b64(png), format: 'png' }])
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 1000,
      total_tokens: 1100,
      input_tokens_details: { text_tokens: 100, image_tokens: 0 },
    })
    expect(result.cost).toEqual({ usd: COST, source: 'rate' })
    expect(result).toMatchObject({ size: '1536x1024', quality: 'low', background: 'auto' })
    expect(reported).toEqual([
      {
        model: FLARE,
        tokens: { input: 100, output: 1000, cacheRead: 0, reasoning: 0 },
        cost: COST,
        costSource: 'rate',
      },
    ])
  })

  test('output_compression is sent only when set, and refused outside 0-100', async () => {
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }], usage }))
    await ok({ prompt: 'x', output_compression: 70 })
    await ok({ prompt: 'x' })
    expect(fake.seen[0]?.json?.output_compression).toBe(70)
    expect(fake.seen[1]?.json).not.toHaveProperty('output_compression')
    for (const bad of [101, -1, 1.5]) {
      expect((await refused({ prompt: 'x', output_compression: bad })).error).toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  test('moderation is sent when set, on the JSON body and on the multipart one', async () => {
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }], usage }))
    fake.on(POST_EDIT, () => Response.json({ data: [{ b64_json: b64(png) }], usage }))
    await ok({ prompt: 'x', moderation: 'low' })
    await ok({ prompt: 'x', moderation: 'low', references: [refPng] })
    expect(fake.seen[0]?.json?.moderation).toBe('low')
    expect(fake.seen[1]?.form?.get('moderation')).toBe('low')
    await ok({ prompt: 'x', references: [refPng] })
    expect(fake.seen[2]?.form?.has('moderation')).toBe(false)
    expect(fake.seen[2]?.form?.has('input_fidelity')).toBe(false)
    expect(fake.seen[2]?.form?.has('stream')).toBe(false)
  })

  test('input_fidelity is refused for a model that answers it with a 400, on either seat, and nothing is sent', async () => {
    for (const model of ['flare', 'sunburst', 'auto'] as const) {
      const { error } = await refused({ prompt: 'x', model, references: [refPng], input_fidelity: 'high' })
      expect(error.code).toBe('INVALID_INPUT')
      expect(error.message).toContain('input_fidelity')
    }
    // and without references it means nothing at all
    expect((await refused({ prompt: 'x', input_fidelity: 'low' })).error.message).toContain('edits only')
    expect(fake.seen).toEqual([])
  })

  test('one reference: multipart `image` on the quality model; the answer says it was routed there', async () => {
    fake.on(POST_EDIT, () =>
      Response.json({
        data: [{ b64_json: b64(png) }],
        usage: { ...usage, input_tokens_details: { text_tokens: 50, image_tokens: 50 } },
      }),
    )
    const mask = file('mask.png', new Uint8Array(pngFixture(8, 8, { alpha: 0 })))
    const { result } = await ok({ prompt: 'make it dusk', quality: 'low', references: [refPng], mask })

    const form = fake.seen[0]?.form
    expect(fake.seen[0]?.path).toBe(POST_EDIT)
    expect(form?.get('model')).toBe(SUNBURST)
    expect(form?.get('prompt')).toBe('make it dusk')
    expect(form?.get('output_format')).toBe('png')
    expect(form?.getAll('image')).toHaveLength(1)
    expect(form?.has('image[]')).toBe(false)
    const sent = form?.get('image')
    expect(sent instanceof File && [sent.name, sent.type, sent.size]).toEqual(['a.png', 'image/png', png.length])
    const sentMask = form?.get('mask')
    expect(sentMask instanceof File && [sentMask.name, sentMask.type]).toEqual(['mask.png', 'image/png'])
    expect(result).toMatchObject({ model: SUNBURST, edit: true, routed: true })
    expect(result.routingReason).toBe(`routed to ${SUNBURST} for editing/reference precision`)
    // (50 text * 5 + 50 image * 8 + 1000 out * 30) / 1e6
    expect(result.cost.usd).toBeCloseTo(0.03065, 8)
  })

  test('two references: the repeated `image[]` field, each with its own mime; an explicit model is not routed', async () => {
    fake.on(POST_EDIT, () => Response.json({ data: [{ b64_json: b64(png) }], usage }))
    const { result } = await ok({ prompt: 'blend', model: 'flare', references: [refPng, refJpeg] })
    const form = fake.seen[0]?.form
    expect(form?.getAll('image[]')).toHaveLength(2)
    expect(form?.has('image')).toBe(false)
    const second = form?.getAll('image[]')[1]
    expect(second instanceof File && [second.name, second.type]).toEqual(['b.jpg', 'image/jpeg'])
    expect(form?.get('model')).toBe(FLARE)
    expect(form?.has('mask')).toBe(false)
    expect(result).toMatchObject({ requestedModel: 'flare', routed: false, model: FLARE })
    expect(result.routingReason).toBeUndefined()
  })

  test('the answer is checked against the format asked for: webp and jpeg, and a png where webp was asked is rejected', async () => {
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(webp) }, { b64_json: b64(png) }], usage }))
    const { result } = await ok({ prompt: 'x', n: 2, output_format: 'webp' })
    expect(fake.seen[0]?.json?.output_format).toBe('webp')
    expect(result.images).toEqual([{ index: 0, b64: b64(webp), format: 'webp' }])
    expect(result.rejected).toEqual([{ index: 1, reason: 'not a valid webp (bad magic bytes)' }])
    fake.reset()
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(jpeg) }], usage }))
    expect((await ok({ prompt: 'x', output_format: 'jpeg' })).result.images[0]?.format).toBe('jpeg')
  })

  test('what the endpoint answered for size, quality, background and created wins over the request', async () => {
    fake.on(POST_GEN, () =>
      Response.json({
        created: 1_700_000_000,
        data: [{ b64_json: b64(png) }],
        size: '1254x1254',
        quality: 'medium',
        background: 'opaque',
        usage: { ...usage, total_tokens: 1234, input_tokens_details: { cached_tokens: 7 } },
      }),
    )
    const { result } = await ok({ prompt: 'x' })
    expect(result).toMatchObject({ created: 1_700_000_000, size: '1254x1254', quality: 'medium', background: 'opaque' })
    expect(result.usage).toMatchObject({ total_tokens: 1234, input_tokens_details: { cached_tokens: 7 } })
  })

  test('without usage the cost is unknown, never 0; with a provider cost it is that', async () => {
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }] }))
    const none = await ok({ prompt: 'x' })
    expect(none.result.cost).toEqual({ usd: null, source: 'unknown' })
    expect(none.result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    fake.reset()
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }], usage: { ...usage, cost: 0.0123 } }))
    expect((await ok({ prompt: 'x' })).result.cost).toEqual({ usd: 0.0123, source: 'provider' })
  })
})

describe('requestImages: refused before anything is sent', () => {
  const cases: [string, ImageRequest, string][] = [
    ['n above 1 with previews', { prompt: 'x', n: 2, partial_images: 1 }, 'only supported with n=1'],
    ['previews above 3', { prompt: 'x', partial_images: 4 }, 'partial_images'],
    ['a size outside the envelope', { prompt: 'x', size: '1254x1254' }, 'multiples of 16'],
    ['a transparent jpeg', { prompt: 'x', background: 'transparent', output_format: 'jpeg' }, 'jpeg has no alpha'],
    ['a mask without a reference', { prompt: 'x', mask: file('m.png', new Uint8Array(png)) }, 'needs at least one'],
    [
      'a mask over 4 MB',
      { prompt: 'x', references: [refPng], mask: file('m.png', new Uint8Array(4 * 1024 * 1024 + 1)) },
      'mask must be at most',
    ],
    [
      'a mask that is not image/png',
      { prompt: 'x', references: [refPng], mask: file('m.jpg', new Uint8Array(png), 'image/jpeg') },
      'mask must be image/png',
    ],
    [
      'a reference that is not png, jpeg or webp',
      { prompt: 'x', references: [file('a.gif', new Uint8Array(1), 'image/gif')] },
      'must be one of',
    ],
    ['17 references', { prompt: 'x', references: Array.from({ length: 17 }, () => refPng) }, 'at most 16'],
  ]
  for (const [name, request, message] of cases) {
    test(name, async () => {
      fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(png) }] }))
      fake.on(POST_EDIT, () => Response.json({ data: [{ b64_json: b64(png) }] }))
      const { error, reported } = await refused(request)
      expect(error.code).toBe('INVALID_INPUT')
      expect(error.message).toContain(message)
      expect(fake.seen).toEqual([])
      expect(reported).toEqual([])
    })
  }

  test('without credentials nothing is sent', async () => {
    const error = await requestImages(
      resolveImageDeps({ env: {} }),
      { addUsage: () => undefined, signal: new AbortController().signal },
      { prompt: 'x' },
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED' })
  })
})

describe('requestImages: the billed request is not sent again', () => {
  test('an error status retries, a garbled 200 does not', async () => {
    fake.on(POST_GEN, (_s, attempt) =>
      attempt === 0 ? new Response('busy', { status: 503 }) : Response.json({ data: [{ b64_json: b64(png) }], usage }),
    )
    expect((await ok({ prompt: 'x' })).result.images).toHaveLength(1)
    expect(fake.seen).toHaveLength(2)
    fake.reset()
    fake.on(POST_GEN, () => new Response('{"data":', { status: 200 }))
    expect((await refused({ prompt: 'x' })).reported).toEqual([])
    expect(fake.seen).toHaveLength(1)
  })

  test('a stream that fails once it has begun is not sent again', async () => {
    fake.on(POST_GEN, stream(sse([partial(0)])))
    const { error } = await refused({ prompt: 'x', partial_images: 2 })
    expect(error.message).toContain('without a completed frame')
    expect(fake.seen).toHaveLength(1)
  })
})

describe('requestImages: streaming', () => {
  test('previews arrive in order, then the final image; the request asks for the stream', async () => {
    fake.on(
      POST_GEN,
      stream(sse([partial(0), partial(1, jpeg), completed(png, { size: '1024x1024', created_at: 1_700_000_001 })])),
    )
    const seen: ImagePartial[] = []
    const { result, reported } = await ok({
      prompt: 'a lighthouse',
      partial_images: 2,
      quality: 'high',
      onPartial: (p) => {
        seen.push(p)
      },
    })

    expect(fake.seen[0]?.json).toMatchObject({ stream: true, partial_images: 2, model: SUNBURST, n: 1 })
    expect(seen).toEqual([
      { b64: b64(png), format: 'png', index: 0 },
      { b64: b64(jpeg), format: 'png', index: 1 },
    ])
    expect(result.images).toEqual([{ index: 0, b64: b64(png), format: 'png' }])
    expect(result).toMatchObject({ created: 1_700_000_001, size: '1024x1024', model: SUNBURST })
    expect(result.cost).toEqual({ usd: COST, source: 'rate' })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ cost: COST, tokens: { input: 100, output: 1000 } })
  })

  test('an edit streams on the image_edit.* events, multipart with stream and partial_images', async () => {
    fake.on(POST_EDIT, stream(sse([partial(0, png, 'image_edit'), completed(png, {}, 'image_edit')])))
    const seen: number[] = []
    const { result } = await ok({
      prompt: 'x',
      references: [refPng],
      partial_images: 3,
      onPartial: (p) => void seen.push(p.index),
    })
    expect(fake.seen[0]?.form?.get('stream')).toBe('true')
    expect(fake.seen[0]?.form?.get('partial_images')).toBe('3')
    expect(seen).toEqual([0])
    expect(result.edit).toBe(true)
  })

  test('fewer previews than asked, or none, is normal; the final image alone is the answer', async () => {
    fake.on(POST_GEN, stream(sse([completed()])))
    const seen: ImagePartial[] = []
    const { result } = await ok({ prompt: 'x', partial_images: 3, onPartial: (p) => void seen.push(p) })
    expect(seen).toEqual([])
    expect(result.images).toHaveLength(1)
  })

  test('frames split anywhere in the stream, CRLF line ends and events named only in the payload read the same', async () => {
    const text = sse([partial(0), completed()])
      .join('')
      .replaceAll('\n', '\r\n')
    fake.on(
      POST_GEN,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder()
              for (let i = 0; i < text.length; i += 7) controller.enqueue(enc.encode(text.slice(i, i + 7)))
              controller.close()
            },
          }),
        ),
    )
    const seen: number[] = []
    const { result } = await ok({ prompt: 'x', partial_images: 1, onPartial: (p) => void seen.push(p.index) })
    expect(seen).toEqual([0])
    expect(result.images).toHaveLength(1)

    fake.reset()
    const bare = [partial(0)[1], completed()[1]].map((data) => `data: ${JSON.stringify(data)}\n\n`)
    fake.on(POST_GEN, stream(bare))
    expect((await ok({ prompt: 'x', partial_images: 1 })).result.images).toHaveLength(1)
  })

  test('an error frame after previews ends the call with its message, and nothing is reported as billed', async () => {
    fake.on(
      POST_GEN,
      stream(sse([partial(0), ['error', { error: { message: 'Your image was blocked by the safety system.' } }]])),
    )
    const seen: number[] = []
    const { error, reported } = await refused({
      prompt: 'x',
      partial_images: 2,
      onPartial: (p) => void seen.push(p.index),
    })
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(error.message).toContain('blocked by the safety system')
    expect(seen).toEqual([0])
    expect(reported).toEqual([])
    // a namespaced error event is one too
    fake.reset()
    fake.on(POST_GEN, stream(sse([['image_generation.error', { oops: true }]])))
    expect((await refused({ prompt: 'x', partial_images: 1 })).error.message).toContain('image stream error')
  })

  test('an error frame and a vendor-wrapped 400 keep the vendor words structured, for the door to answer with', async () => {
    fake.on(POST_GEN, stream(sse([['image_generation.error', { error: { message: 'blocked at output' } }]])))
    expect((await refused({ prompt: 'x', partial_images: 1 })).error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      data: { userError: { message: 'blocked at output' } },
    })

    fake.reset()
    const wrapped =
      '[OpenAI Vendor Group Key StatusCode: BadRequest] {"error":{"message":"Your request was rejected by the safety system.","type":"image_generation_user_error","code":"moderation_blocked","moderation_details":{"moderation_stage":"input","categories":["violence","self-harm"]}}}'
    fake.on(POST_GEN, () => new Response(wrapped, { status: 503 }))
    const { error } = await refused({ prompt: 'x' })
    expect(error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      data: {
        status: 503,
        userError: {
          message: 'Your request was rejected by the safety system.',
          code: 'moderation_blocked',
          moderation: { stage: 'input', categories: ['violence', 'self-harm'] },
        },
      },
    })
    expect(error.message).toContain('moderation stage input')
    expect(fake.attempts[POST_GEN]).toBe(1)
  })

  test('a mid-stream moderation block keeps its code, stage and categories', async () => {
    fake.on(
      POST_GEN,
      stream(
        sse([
          partial(0),
          [
            'image_generation.error',
            {
              error: {
                message: 'Blocked at the output stage.',
                code: 'moderation_blocked',
                moderation_details: { moderation_stage: 'output', categories: ['violence'] },
              },
            },
          ],
        ]),
      ),
    )
    const { error } = await refused({ prompt: 'x', partial_images: 1 })
    expect(error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      data: {
        userError: {
          message: 'Blocked at the output stage.',
          code: 'moderation_blocked',
          moderation: { stage: 'output', categories: ['violence'] },
        },
      },
    })
  })

  test('a vendor block that names only a stage, or only categories, keeps what it names', async () => {
    const wrap = (details: Record<string, unknown>) =>
      `[OpenAI Vendor Group Key StatusCode: BadRequest] ${JSON.stringify({
        error: {
          message: 'blocked',
          type: 'image_generation_user_error',
          code: 'moderation_blocked',
          moderation_details: details,
        },
      })}`
    fake.on(POST_GEN, () => new Response(wrap({ moderation_stage: 'input' }), { status: 503 }))
    const stageOnly = await refused({ prompt: 'x' })
    expect(stageOnly.error).toMatchObject({ data: { userError: { moderation: { stage: 'input' } } } })
    expect(stageOnly.error.message).toContain('(moderation stage input)')
    expect((stageOnly.error.data as { userError: { moderation: object } }).userError.moderation).not.toHaveProperty(
      'categories',
    )

    fake.reset()
    fake.on(POST_GEN, () => new Response(wrap({ categories: ['violence', 7, 'self-harm'] }), { status: 503 }))
    const categoriesOnly = await refused({ prompt: 'x' })
    expect(categoriesOnly.error).toMatchObject({
      data: { userError: { moderation: { categories: ['violence', 'self-harm'] } } },
    })
    expect(categoriesOnly.error.message).toContain('(categories violence, self-harm)')
  })

  test('a stream that sends more previews than asked (and one slack) is dropped, not forwarded', async () => {
    fake.on(POST_GEN, stream(sse([partial(0), partial(1), partial(2), completed()])))
    const seen: number[] = []
    const { error } = await refused({ prompt: 'x', partial_images: 1, onPartial: (p) => void seen.push(p.index) })
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('more than the 1 previews asked for')
    expect(seen).toEqual([0, 1]) // asked + 1 slack, the third is refused
  })

  test('a stream that keeps trickling is cut at the whole-stream ceiling, though it is never idle', async () => {
    const encoder = new TextEncoder()
    fake.on(POST_GEN, () => {
      let timer: ReturnType<typeof setInterval> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n')), 10)
          },
          cancel() {
            clearInterval(timer)
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const { error, reported } = await refused({ prompt: 'x', partial_images: 1 }, 5_000, 120)
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('ran past 120ms in all')
    expect(reported).toEqual([])
  })

  test('a failure below the vendor (no answer, a cut body) is marked transport; a vendor status line is not', async () => {
    const env = { IU_API_KEY: 'test-key', IU_BASE_URL: fake.baseUrl }
    const reset = resolveImageDeps({
      env,
      retry: { backoffMs: 0 },
      fetch: () => Promise.reject(new TypeError('fetch failed: ECONNRESET 10.0.0.5:443')),
    })
    const failure = await requestImages(
      reset,
      { addUsage: () => {}, signal: new AbortController().signal },
      { prompt: 'x' },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'UPSTREAM_ERROR', data: { transport: true } })

    fake.on(POST_GEN, () => Response.json({ error: { message: 'overloaded' } }, { status: 500 }))
    const status = await refused({ prompt: 'x' })
    expect(status.error.data).toMatchObject({ status: 500 })
    expect(status.error.data).not.toHaveProperty('transport')
  })

  test('the magic check reads the first bytes only: a valid header with a junk body is not decoded further', async () => {
    const junk = new Uint8Array(png.length + 64).fill(7)
    junk.set(png.subarray(0, 12))
    fake.on(POST_GEN, () => Response.json({ data: [{ b64_json: b64(junk) }, { b64_json: b64(jpeg) }], usage }))
    const { result } = await ok({ prompt: 'x', n: 2 })
    expect(result.images.map((i) => i.index)).toEqual([0])
    expect(result.rejected).toEqual([{ index: 1, reason: 'not a valid png (bad magic bytes)' }])
  })

  test('a stream with no completed frame is an error, previews or not', async () => {
    fake.on(POST_GEN, stream(sse([partial(0), partial(1)])))
    const { error } = await refused({ prompt: 'x', partial_images: 2 })
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('without a completed frame')
    fake.reset()
    fake.on(POST_GEN, stream([]))
    expect((await refused({ prompt: 'x', partial_images: 2 })).error.message).toContain('without a completed frame')
  })

  test('only the first completed frame counts', async () => {
    fake.on(POST_GEN, stream(sse([completed(png), completed(jpeg)])))
    const { result } = await ok({ prompt: 'x', partial_images: 1 })
    expect(result.images.map((i) => i.b64)).toEqual([b64(png)])
  })

  test('a final image that is not the format asked for is an error, and the billed call is still reported', async () => {
    fake.on(POST_GEN, stream(sse([partial(0), completed(new TextEncoder().encode('<html>not an image</html>'))])))
    const { error, reported } = await refused({ prompt: 'x', partial_images: 1 })
    expect(error.message).toContain('not a valid png (bad magic bytes)')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.cost).toBe(COST)
    // the format the completed frame names is the one checked
    fake.reset()
    fake.on(POST_GEN, stream(sse([completed(jpeg, { output_format: 'jpeg' })])))
    const { result } = await ok({ prompt: 'x', partial_images: 1, output_format: 'png' })
    expect(result.images[0]?.format).toBe('jpeg')
  })

  test('a frame over the buffer bound is refused rather than buffered', async () => {
    fake.on(POST_GEN, () => new Response(`data: ${'A'.repeat(46_000_000)}`))
    const { error } = await refused({ prompt: 'x', partial_images: 1 })
    expect(error.message).toContain('stream frame is over')
  })

  test('a stream that goes quiet is aborted by the idle guard, not by a budget', async () => {
    fake.on(
      POST_GEN,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse([partial(0)]).join('')))
            },
          }),
        ),
    )
    const started = performance.now()
    const { error } = await refused({ prompt: 'x', partial_images: 1 }, 150)
    expect(error.message).toContain('stream idle for 150ms')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test('a slow stream that keeps sending is never cut by the idle guard', async () => {
    const frames = sse([partial(0), partial(1), completed()])
    fake.on(
      POST_GEN,
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (const frame of frames) {
                await Bun.sleep(80)
                controller.enqueue(new TextEncoder().encode(frame))
              }
              controller.close()
            },
          }),
        ),
    )
    const { value, error } = await run({ prompt: 'x', partial_images: 2 }, 150)
    expect(error).toBeUndefined()
    expect(value?.images).toHaveLength(1)
  })

  test('a callback that throws ends the call', async () => {
    fake.on(POST_GEN, stream(sse([partial(0), completed()])))
    const { error } = await refused({
      prompt: 'x',
      partial_images: 1,
      onPartial: () => {
        throw new Error('client went away')
      },
    })
    expect(error.message).toContain('client went away')
  })

  test('a cancelled call is CANCELLED, not an upstream error', async () => {
    fake.on(POST_GEN, stream(sse([completed()])))
    const controller = new AbortController()
    controller.abort()
    const error = await requestImages(
      deps(),
      { addUsage: () => undefined, signal: controller.signal },
      {
        prompt: 'x',
        partial_images: 1,
      },
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'CANCELLED' })
  })
})
