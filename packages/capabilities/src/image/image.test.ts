import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ROUTES as IMAGE_ROUTES } from '@agent-workflows/routes'
import type { Usage } from '../context.ts'
import { createRegistry } from '../registry.ts'
import { CapabilityCallError } from '../errors.ts'
import { createImageCapabilities } from './index.ts'
import { magicBytesValid, readPng } from './png.ts'
import { SIZE_PRESETS, snapSize, validateSize } from './size.ts'
import { pickRoute } from './generate.ts'
import { b64, type FakeHandler, pngFixture, startFakeImageServer, webpFixture } from './testing.ts'
import { decodeAlphaStats } from './png.ts'

// A fake IU endpoint on a real socket answering the images API and Replicate; Replicate's CDN is a map inside `fetch`.
const fake = startFakeImageServer()
let cdn: Record<string, Uint8Array<ArrayBuffer> | (() => Response)> = {}
let delivered: { url: string; init: RequestInit }[] = []
const root = mkdtempSync(join(tmpdir(), 'agw-image-cap-'))

const POST_GEN = '/openai/v1/images/generations'
const POST_EDIT = '/openai/v1/images/edits'
const POST_PREDICT = (model: string) => `/replicate/v1/models/${model}/predictions`

afterAll(() => {
  fake.stop()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  fake.reset()
  cdn = {}
  delivered = []
})

/** `handlers[path] = fn` reads like the table of what the endpoint answers. */
const handlers = new Proxy<Record<string, FakeHandler>>(
  {},
  {
    set(_target, path: string, handler: FakeHandler) {
      fake.on(path, handler)
      return true
    },
  },
)

const env = () => ({ IU_API_KEY: 'test-key', IU_BASE_URL: fake.baseUrl })
const registry = () =>
  createRegistry(
    createImageCapabilities({
      env: env(),
      retry: { backoffMs: 0 },
      pollMs: 1,
      fetch: (url, init) => {
        const hit = cdn[url]
        if (!hit) return fetch(url, init)
        delivered.push({ url, init })
        return Promise.resolve(typeof hit === 'function' ? hit() : new Response(hit))
      },
    }),
  )

async function call(id: 'image.generate' | 'image.cutout', input: Record<string, unknown>) {
  const usage: Usage[] = []
  const result = await registry().call(id, input as never, { addUsage: (u) => usage.push(u) })
  // biome-ignore lint/suspicious/noExplicitAny: the outputs are asserted field by field
  return { result: result as Record<string, any>, usage }
}
async function failure(id: 'image.generate' | 'image.cutout', input: Record<string, unknown>) {
  const usage: Usage[] = []
  const error = await registry()
    .call(id, input as never, { addUsage: (u) => usage.push(u) })
    .then(
      () => undefined,
      (e: unknown) => e,
    )
  if (!(error instanceof CapabilityCallError)) throw new Error('expected a CapabilityCallError')
  return { error, usage }
}

const file = (name: string, bytes: Uint8Array) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

const FLARE = IMAGE_ROUTES['image.flare'].model
const SUNBURST = IMAGE_ROUTES['image.sunburst'].model
const png = pngFixture(8, 8)
const images = (n: number, bytes: Uint8Array = png) => ({
  data: Array.from({ length: n }, () => ({ b64_json: b64(bytes) })),
})
const usage = { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }

describe('image.generate', () => {
  test('a prompt: the request names the routed model, snapped size and png; images come back decoded, the call is priced', async () => {
    handlers[POST_GEN] = () => Response.json({ ...images(2), usage })
    const { result, usage: reported } = await call('image.generate', {
      prompt: 'a lighthouse',
      quality: 'low',
      n: 2,
      size: '1536x1024',
    })

    expect(fake.seen).toHaveLength(1)
    expect(fake.seen[0]?.headers.get('authorization')).toBe('Bearer test-key')
    expect(fake.seen[0]?.json).toEqual({
      model: FLARE,
      prompt: 'a lighthouse',
      n: 2,
      size: '1536x1024',
      quality: 'low',
      background: 'auto',
      output_format: 'png',
    })
    expect(result.images).toHaveLength(2)
    expect(result.images[0]).toMatchObject({ width: 8, height: 8, hasAlpha: true, bytes: png.length })
    expect(result).toMatchObject({ model: FLARE, size: '1536x1024', quality: 'low', edit: false })
    expect(result.snappedFrom).toBeUndefined()
    // (100 text * 5 + 1000 out * 30) / 1e6
    expect(result.cost).toEqual({ usd: 0.0305, source: 'rate' })
    expect(reported).toEqual([
      {
        model: FLARE,
        tokens: { input: 100, output: 1000, cacheRead: 0, reasoning: 0 },
        cost: 0.0305,
        costSource: 'rate',
      },
    ])
  })

  test('the provider cost, when the endpoint reports one, is the price', async () => {
    handlers[POST_GEN] = () => Response.json({ ...images(1), usage: { ...usage, cost: 0.0123 } })
    const { result, usage: reported } = await call('image.generate', { prompt: 'x' })
    expect(result.cost).toEqual({ usd: 0.0123, source: 'provider' })
    expect(reported[0]).toMatchObject({ cost: 0.0123, costSource: 'provider' })
  })

  test('a response without usage is priced unknown, never 0', async () => {
    handlers[POST_GEN] = () => Response.json(images(1))
    const { result, usage: reported } = await call('image.generate', { prompt: 'x' })
    expect(result.cost).toEqual({ usd: null, source: 'unknown' })
    expect(reported[0]).toMatchObject({ cost: null, costSource: 'unknown' })
  })

  test('a size the endpoint would refuse is snapped into its envelope and reported', async () => {
    handlers[POST_GEN] = () => Response.json({ ...images(1), usage })
    const { result } = await call('image.generate', { prompt: 'x', size: '1254x1254' })
    expect(fake.seen[0]?.json?.size).toBe(snapSize('1254x1254'))
    expect(validateSize(String(fake.seen[0]?.json?.size))).toBeNull()
    expect(result).toMatchObject({ size: snapSize('1254x1254'), snappedFrom: '1254x1254' })
  })

  test('auto routing: an edit and a final-quality render go to the quality model, drafts to the speed model', () => {
    expect(pickRoute('auto', 'low', false)).toBe('image.flare')
    expect(pickRoute('auto', 'medium', false)).toBe('image.flare')
    expect(pickRoute('auto', 'auto', false)).toBe('image.flare')
    for (const quality of ['high', 'xhigh', 'max'] as const)
      expect(pickRoute('auto', quality, false)).toBe('image.sunburst')
    expect(pickRoute('auto', 'low', true)).toBe('image.sunburst')
    expect(pickRoute('flare', 'max', true)).toBe('image.flare')
    expect(pickRoute('sunburst', 'low', false)).toBe('image.sunburst')
  })

  test('input images make it an edit: multipart to /images/edits, `image` for one file, `image[]` for several, on the quality model', async () => {
    handlers[POST_EDIT] = () =>
      Response.json({ ...images(1), usage: { ...usage, input_tokens_details: { text_tokens: 50, image_tokens: 50 } } })
    const a = file('a.png', png)
    const b = file('b.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))

    const one = await call('image.generate', { prompt: 'make it night', images: [a], quality: 'low' })
    expect(fake.seen[0]?.path).toBe(POST_EDIT)
    expect(fake.seen[0]?.form?.get('model')).toBe(SUNBURST)
    expect(fake.seen[0]?.form?.get('prompt')).toBe('make it night')
    expect(fake.seen[0]?.form?.get('output_format')).toBe('png')
    expect(fake.seen[0]?.form?.getAll('image')).toHaveLength(1)
    expect(fake.seen[0]?.form?.has('image[]')).toBe(false)
    expect(one.result.edit).toBe(true)
    // (50 text * 5 + 50 image * 8 + 1000 out * 30) / 1e6: the image input bills at its own rate
    expect(one.result.cost.usd).toBeCloseTo(0.03065, 8)

    await call('image.generate', { prompt: 'blend', images: [a, b] })
    expect(fake.seen[1]?.form?.getAll('image[]')).toHaveLength(2)
    const second = fake.seen[1]?.form?.getAll('image[]')[1]
    expect(second instanceof File && second.type).toBe('image/jpeg')
  })

  test('a 503 wrapping a 400, in either shape, is not retried and carries the vendor message', async () => {
    const bodies = [
      '{"error":{"message":"Your request was rejected by the safety system.","type":"image_generation_user_error","code":"moderation_blocked","moderation_details":{"moderation_stage":"input","categories":["violence"]}}}',
      '[OpenAI Vendor Group Key StatusCode: BadRequest] {"error":{"message":"Invalid value: size","type":"invalid_request_error","code":"invalid_value"}}',
    ]
    for (const body of bodies) {
      fake.reset()
      handlers[POST_GEN] = () => new Response(body, { status: 503 })
      const { error, usage: reported } = await failure('image.generate', { prompt: 'x' })
      expect(fake.seen).toHaveLength(1)
      expect(error.code).toBe('UPSTREAM_ERROR')
      expect(error.message).toContain(body.includes('safety') ? 'safety system' : 'Invalid value: size')
      expect(reported).toEqual([])
    }
    handlers[POST_GEN] = () => new Response(bodies[0], { status: 503 })
    expect((await failure('image.generate', { prompt: 'x' })).error.message).toContain('moderation_blocked')
    expect((await failure('image.generate', { prompt: 'x' })).error.message).toContain('categories violence')
  })

  test('a genuine 503 and a 429 are retried; the third attempt succeeds', async () => {
    handlers[POST_GEN] = (_s, attempt) =>
      attempt === 0
        ? new Response('upstream busy', { status: 503 })
        : attempt === 1
          ? new Response('slow down', { status: 429 })
          : Response.json({ ...images(1), usage })
    const { result } = await call('image.generate', { prompt: 'x' })
    expect(fake.seen).toHaveLength(3)
    expect(result.images).toHaveLength(1)
  })

  test('retries are bounded: three attempts, then the upstream error with its status', async () => {
    handlers[POST_GEN] = () => new Response('still down', { status: 502 })
    const { error } = await failure('image.generate', { prompt: 'x' })
    expect(fake.seen).toHaveLength(3)
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 502 } })
  })

  test('410 (a retired model) fails fast and says so', async () => {
    handlers[POST_GEN] = () => new Response('gone', { status: 410 })
    const { error } = await failure('image.generate', { prompt: 'x' })
    expect(fake.seen).toHaveLength(1)
    expect(error.message).toContain('model deprecated (410)')
  })

  test('a body that is not a PNG is refused by its magic bytes, and the billed call is still reported', async () => {
    handlers[POST_GEN] = () =>
      Response.json({ ...images(1, new TextEncoder().encode('<html>not an image</html>')), usage })
    const { error, usage: reported } = await failure('image.generate', { prompt: 'x' })
    expect(error.message).toContain('not a valid png')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.cost).toBe(0.0305)
  })

  test('no images in the answer is an upstream error', async () => {
    handlers[POST_GEN] = () => Response.json({ data: [], usage })
    expect((await failure('image.generate', { prompt: 'x' })).error.message).toContain('no images')
  })

  test('input files are checked before anything is sent', async () => {
    handlers[POST_EDIT] = () => Response.json(images(1))
    const text = file('notes.png', new TextEncoder().encode('just text'))
    for (const [images, message] of [
      [['relative/photo.png'], 'must be absolute'],
      [[join(root, 'missing.png')], 'no such file'],
      [[root], 'no such file'],
      [[text], 'png, jpeg or webp'],
    ] as const) {
      const { error } = await failure('image.generate', { prompt: 'x', images: [...images] })
      expect(error.code).toBe('INVALID_INPUT')
      expect(error.message).toContain(message)
    }
    expect(fake.seen).toEqual([])
  })

  test('the schema rejects what the endpoint would: n out of range, an unknown quality, a stray key', async () => {
    for (const bad of [{ n: 11 }, { n: 0 }, { quality: 'ultra' }, { size: 'big' }, { colour: 'red' }]) {
      const { error } = await failure('image.generate', { prompt: 'x', ...bad })
      expect(error.status).toBe(400)
    }
    expect(fake.seen).toEqual([])
  })

  test('without credentials nothing is sent', async () => {
    const bare = createRegistry(createImageCapabilities({ env: {} }))
    const error = await bare.call('image.generate', { prompt: 'x' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED' })
  })
})

describe('image.cutout', () => {
  const source = () => file('subject.png', pngFixture(300, 280, { kind: 'rgb' }))
  const RECRAFT = IMAGE_ROUTES['image.cutout.recraft'].model
  const BRIA = IMAGE_ROUTES['image.cutout.bria'].model
  const DELIVERED = 'https://replicate.delivery/out/cutout.webp'

  test('recraft delivers WebP: it comes back a PNG with an alpha channel, priced per call, and the request is the data-URI input', async () => {
    cdn[DELIVERED] = await webpFixture(300, 280)
    handlers[POST_PREDICT(RECRAFT)] = () => Response.json({ id: 'p1', status: 'succeeded', output: DELIVERED })
    const { result, usage: reported } = await call('image.cutout', { file: source() })

    expect(fake.seen[0]?.headers.get('prefer')).toBe('wait')
    const sent = fake.seen[0]?.json?.input as { image: string } | undefined
    expect(sent?.image).toStartWith('data:image/png;base64,')
    const out = Buffer.from(result.image.b64, 'base64')
    expect(magicBytesValid(out, 'png')).toBe(true)
    expect(result.image).toMatchObject({ width: 300, height: 280, hasAlpha: true, bytes: out.length })
    expect(result).toMatchObject({ model: RECRAFT, cost: { usd: 0.01, source: 'rate' } })
    expect(reported).toEqual([
      { model: RECRAFT, tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 }, cost: 0.01, costSource: 'rate' },
    ])
  })

  test('bria is its own model and its own price; a PNG delivery passes through', async () => {
    cdn[DELIVERED] = pngFixture(300, 280)
    handlers[POST_PREDICT(BRIA)] = () => Response.json({ status: 'succeeded', output: [DELIVERED] })
    const { result } = await call('image.cutout', { file: source(), model: 'bria' })
    expect(result).toMatchObject({ model: BRIA, cost: { usd: 0.018, source: 'rate' } })
  })

  test('a prediction still running is polled on the flat /predictions/{id} path until it succeeds', async () => {
    cdn[DELIVERED] = pngFixture(300, 280)
    handlers[POST_PREDICT(RECRAFT)] = () => Response.json({ id: 'p9', status: 'starting' })
    handlers['/replicate/v1/predictions/p9'] = (_s, attempt) =>
      Response.json(
        attempt < 2 ? { id: 'p9', status: 'processing' } : { id: 'p9', status: 'succeeded', output: DELIVERED },
      )
    await call('image.cutout', { file: source() })
    expect(fake.attempts['/replicate/v1/predictions/p9']).toBe(3)
  })

  test('a failed prediction is an upstream error with Replicate message and costs nothing', async () => {
    handlers[POST_PREDICT(RECRAFT)] = () => Response.json({ status: 'failed', error: 'NSFW content detected' })
    const { error, usage: reported } = await failure('image.cutout', { file: source() })
    expect(error.message).toContain('failed: NSFW content detected')
    expect(reported).toEqual([])
  })

  test('an output URL outside replicate.delivery is refused and never fetched; the succeeded call was billed', async () => {
    cdn['https://evil.example/out.png'] = pngFixture(300, 280)
    handlers[POST_PREDICT(RECRAFT)] = () =>
      Response.json({ status: 'succeeded', output: 'https://evil.example/out.png' })
    const { error, usage: reported } = await failure('image.cutout', { file: source() })
    expect(error.message).toContain('not a replicate.delivery URL')
    expect(reported).toHaveLength(1)
  })

  test('a delivery that is neither PNG nor WebP is rejected', async () => {
    cdn[DELIVERED] = new TextEncoder().encode('<html>')
    handlers[POST_PREDICT(RECRAFT)] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    expect((await failure('image.cutout', { file: source() })).error.message).toContain('neither png nor webp')
  })

  test('a 503-wrapped 400 on create is not retried', async () => {
    handlers[POST_PREDICT(RECRAFT)] = () =>
      new Response(
        '[OpenAI Vendor Group Key StatusCode: BadRequest] {"error":{"message":"bad input","type":"invalid_request_error"}}',
        { status: 503 },
      )
    await failure('image.cutout', { file: source() })
    expect(fake.seen).toHaveLength(1)
  })

  test("recraft's limits are enforced before the call: sides under 256, a JPEG that cannot be decoded, a non-image", async () => {
    handlers[POST_PREDICT(RECRAFT)] = () => Response.json({ status: 'failed' })
    const small = file('small.png', pngFixture(100, 100))
    const junk = file('junk.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0]))
    const text = file('text.png', new TextEncoder().encode('hello'))
    for (const [path, message] of [
      [small, 'at least 256px'],
      [junk, 'unreadable image'],
      [text, 'png, jpeg or webp'],
    ] as const) {
      const { error } = await failure('image.cutout', { file: path })
      expect(error.code).toBe('INVALID_INPUT')
      expect(error.message).toContain(message)
    }
    expect(fake.seen).toEqual([])
  })

  test('the Replicate base is derived from the OpenAI one, or taken from the override', async () => {
    const { replicateBase } = await import('./index.ts')
    expect(replicateBase('https://iu.example/openai/v1')).toBe('https://iu.example/replicate/v1')
    expect(replicateBase('https://iu.example/openai/v1/')).toBe('https://iu.example/replicate/v1')
    expect(replicateBase('https://iu.example/openai/v1', 'https://r.example/v1/')).toBe('https://r.example/v1')
    expect(() => replicateBase('https://iu.example/other')).toThrow('cannot derive')
  })
})

describe('review fixes', () => {
  const sentImage = () => String((fake.seen[0]?.json?.input as { image?: string } | undefined)?.image)
  const DELIVERED = 'https://replicate.delivery/out/cutout.png'
  const RECRAFT = IMAGE_ROUTES['image.cutout.recraft'].model
  const PREDICT = `/replicate/v1/models/${RECRAFT}/predictions`
  const u16 = (n: number) => [(n >> 8) & 255, n & 255]
  /** A JPEG that is only headers, claiming a huge canvas. */
  const hugeJpeg = () =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      4,
      0,
      0,
      0xff,
      0xc0,
      0,
      17,
      8,
      ...u16(60_000),
      ...u16(60_000),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
      0xff,
      0xd9,
    ])
  const subject = () => file('review-subject.png', pngFixture(300, 280, { kind: 'rgb' }))

  test('a crafted header claiming 60000x60000 is refused on its numbers, before anything decodes or is sent', async () => {
    const { error } = await failure('image.cutout', { file: file('huge.jpg', hugeJpeg()) })
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.message).toContain('at most 4096px')
    expect(fake.seen).toEqual([])
  })

  test('an ordinary JPEG is sent as it is: the 5 MB limit is on the file, not on a PNG re-encode of it', async () => {
    const jpeg = await new Bun.Image(pngFixture(1600, 1200, { kind: 'rgb' })).jpeg({ quality: 90 }).bytes()
    cdn[DELIVERED] = pngFixture(1600, 1200)
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    await call('image.cutout', { file: file('camera.jpg', jpeg) })
    const sent = sentImage()
    expect(sent).toStartWith('data:image/jpeg;base64,')
    expect(Buffer.from(sent.split(',')[1] ?? '', 'base64').equals(Buffer.from(jpeg))).toBe(true)
  })

  test('a source over the limit says so', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(pngFixture(300, 280, { kind: 'rgb' }))
    const { error } = await failure('image.cutout', { file: file('big.png', big) })
    expect(error.message).toContain('over the 5242880 byte limit')
  })

  test('a JPEG with an EXIF rotation is re-encoded upright, and its displayed size is what the limits see', async () => {
    const jpeg = await new Bun.Image(pngFixture(300, 280, { kind: 'rgb' })).jpeg({ quality: 90 }).bytes()
    // insert an APP1/Exif segment with orientation 6 right after SOI
    const exif = [
      0xff,
      0xe1,
      ...u16(2 + 6 + 8 + 2 + 12 + 4),
      0x45,
      0x78,
      0x69,
      0x66,
      0,
      0,
      0x4d,
      0x4d,
      0,
      0x2a,
      0,
      0,
      0,
      8,
      0,
      1,
      0x01,
      0x12,
      0,
      3,
      0,
      0,
      0,
      1,
      ...u16(6),
      0,
      0,
      0,
      0,
      0,
      0,
    ]
    const rotated = new Uint8Array([0xff, 0xd8, ...exif, ...jpeg.slice(2)])
    cdn[DELIVERED] = pngFixture(280, 300)
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    await call('image.cutout', { file: file('rotated.jpg', rotated) })
    const sent = Buffer.from(sentImage().split(',')[1] ?? '', 'base64')
    expect(sent.equals(Buffer.from(rotated))).toBe(false)
    const meta = await new Bun.Image(sent, { autoOrient: false }).metadata()
    expect(meta.format).toBe('jpeg')
  })

  test('a started prediction is on the run even when polling then fails', async () => {
    handlers[PREDICT] = () => Response.json({ id: 'px', status: 'starting' })
    handlers['/replicate/v1/predictions/px'] = () => new Response('{"detail":"bad request"}', { status: 400 })
    const { error, usage } = await failure('image.cutout', { file: subject() })
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ model: RECRAFT, cost: 0.01, costSource: 'rate' })
  })

  test('a prediction that fails on create is not billed', async () => {
    handlers[PREDICT] = () => Response.json({ status: 'failed', error: 'boom' })
    expect((await failure('image.cutout', { file: subject() })).usage).toEqual([])
  })

  test('a transient failure of one poll is retried, and the price is recorded once', async () => {
    cdn[DELIVERED] = pngFixture(300, 280)
    handlers[PREDICT] = () => Response.json({ id: 'py', status: 'processing' })
    handlers['/replicate/v1/predictions/py'] = (_s, attempt) =>
      attempt === 0
        ? new Response('busy', { status: 503 })
        : Response.json({ id: 'py', status: 'succeeded', output: DELIVERED })
    const { usage } = await call('image.cutout', { file: subject() })
    expect(fake.attempts['/replicate/v1/predictions/py']).toBe(2)
    expect(usage).toHaveLength(1)
  })

  test('the output is fetched without following redirects, and a redirect is an error', async () => {
    cdn[DELIVERED] = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    const { error, usage } = await failure('image.cutout', { file: subject() })
    expect(error.message).toContain('could not be fetched (302)')
    expect(delivered[0]?.init.redirect).toBe('manual')
    expect(usage).toHaveLength(1)
  })

  test('an output body over the bound is refused, declared or not', async () => {
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    cdn[DELIVERED] = () => new Response('x', { headers: { 'content-length': String(65 * 1024 * 1024) } })
    expect((await failure('image.cutout', { file: subject() })).error.message).toContain('over 67108864 bytes')
  })

  test('one bad image among n does not discard the valid, billed ones; it is reported', async () => {
    handlers[POST_GEN] = () =>
      Response.json({
        data: [{ b64_json: b64(png) }, { b64_json: b64(new TextEncoder().encode('<html>')) }, { b64_json: b64(png) }],
        usage,
      })
    const { result, usage: reported } = await call('image.generate', { prompt: 'x', n: 3 })
    expect(result.images).toHaveLength(2)
    expect(result.rejected).toEqual([{ index: 1, reason: 'not a valid png (bad magic bytes)' }])
    expect(reported).toHaveLength(1)
  })

  /** The registry over a `fetch` of the test's own, to make the transport fail the way a network does. */
  const withFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) =>
    createRegistry(createImageCapabilities({ env: env(), retry: { backoffMs: 0 }, pollMs: 1, fetch: impl }))
  const refused = () => Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })

  test('the billed create POST is not sent again after it may have landed: a 503, a dropped connection, a garbled 200', async () => {
    handlers[PREDICT] = () => new Response('upstream busy', { status: 503 })
    const { error } = await failure('image.cutout', { file: subject() })
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(fake.seen).toHaveLength(1)

    fake.reset()
    handlers[PREDICT] = () => new Response('not json', { status: 200 })
    expect((await failure('image.cutout', { file: subject() })).usage).toEqual([])
    expect(fake.seen).toHaveLength(1)

    fake.reset()
    let sent = 0
    const dropped = withFetch(async () => {
      sent++
      throw new Error('socket hang up')
    })
    await dropped.call('image.cutout', { file: subject() }).then(
      () => undefined,
      () => undefined,
    )
    expect(sent).toBe(1)
  })

  test('only proof that nothing started repeats the create POST: a refused connection, a 429', async () => {
    let sent = 0
    const refusedOnce = withFetch(async (url, init) => {
      sent++
      if (sent === 1) throw refused()
      return fetch(url, init)
    })
    cdn[DELIVERED] = pngFixture(300, 280)
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    const usage: Usage[] = []
    // the delivery URL is the CDN map's, which `refusedOnce` does not have: it goes to the real fetch and fails after the create succeeded
    await refusedOnce
      .call('image.cutout', { file: subject() }, { addUsage: (u) => usage.push(u) })
      .catch(() => undefined)
    expect(fake.seen).toHaveLength(1)
    expect(usage).toHaveLength(1)

    fake.reset()
    handlers[PREDICT] = (_s, attempt) =>
      attempt === 0
        ? new Response('slow down', { status: 429 })
        : Response.json({ status: 'succeeded', output: DELIVERED })
    const { usage: after429 } = await call('image.cutout', { file: subject() })
    expect(fake.seen).toHaveLength(2)
    expect(after429).toHaveLength(1)
  })

  test('a create body that does not fit, or a status Replicate does not have, is not billed', async () => {
    for (const body of [{}, { status: 'warming' }, { status: 7 }, []]) {
      handlers[PREDICT] = () => Response.json(body)
      const { error, usage } = await failure('image.cutout', { file: subject() })
      expect(error.message).toContain('does not fit')
      expect(usage).toEqual([])
    }
  })

  test('a delivery whose header claims too many pixels is refused before it decodes, PNG or WebP', async () => {
    handlers[PREDICT] = () => Response.json({ status: 'succeeded', output: DELIVERED })
    const huge = pngFixture(300, 280)
    new DataView(huge.buffer).setUint32(16, 20_000)
    new DataView(huge.buffer).setUint32(20, 20_000)
    // RIFF....WEBPVP8X, 20000 x 20000
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    webp.set([19_999 & 255, (19_999 >> 8) & 255, 0, 19_999 & 255, (19_999 >> 8) & 255, 0], 24)
    for (const bytes of [huge, webp]) {
      cdn[DELIVERED] = bytes
      expect((await failure('image.cutout', { file: subject() })).error.message).toContain('pixels, over the bound')
    }
  })

  test('the create and poll answers are read within a bound, and redirects are not followed', async () => {
    handlers[PREDICT] = () => new Response(`${' '.repeat(1_100_000)}{}`)
    expect((await failure('image.cutout', { file: subject() })).error.message).toContain('is over 1048576 bytes')
    fake.reset()
    handlers[PREDICT] = () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/' } })
    const { error } = await failure('image.cutout', { file: subject() })
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(fake.seen).toHaveLength(1)
  })

  test('image answers are read within a bound; an entry over the per-image cap is rejected, not decoded; redirects are errors', async () => {
    handlers[POST_GEN] = () => new Response(' '.repeat(46_000_000))
    expect((await failure('image.generate', { prompt: 'x' })).error.message).toContain('body is over')
    fake.reset()
    handlers[POST_GEN] = () =>
      Response.json({ data: [{ b64_json: b64(png) }, { b64_json: 'A'.repeat(44_800_000) }], usage })
    const { result } = await call('image.generate', { prompt: 'x', n: 2 })
    expect(result.images).toHaveLength(1)
    expect(result.rejected).toEqual([{ index: 1, reason: 'over the 33554432 byte cap for one image' }])
    fake.reset()
    handlers[POST_GEN] = () =>
      new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${fake.baseUrl}/` } })
    expect((await failure('image.generate', { prompt: 'x' })).error.code).toBe('UPSTREAM_ERROR')
    expect(fake.seen).toHaveLength(1)
  })

  test('a billed generation is not sent again after a dropped connection or a garbled 200; an error status still retries', async () => {
    let sent = 0
    const dropped = withFetch(async () => {
      sent++
      throw new Error('socket hang up')
    })
    await dropped.call('image.generate', { prompt: 'x' }).catch(() => undefined)
    expect(sent).toBe(1)
    handlers[POST_GEN] = () => new Response('{"data":', { status: 200 })
    expect((await failure('image.generate', { prompt: 'x' })).usage).toEqual([])
    expect(fake.seen).toHaveLength(1)
  })

  test('a cutout of a real alpha matte decodes to the shares the rule needs', async () => {
    const matte = pngFixture(300, 280, { alphaAt: (x) => (x < 150 ? 0 : 255) })
    expect(await decodeAlphaStats(matte)).toMatchObject({ translucent: 150 * 280, opaque: 150 * 280 })
  })
})

describe('size rules', () => {
  test('auto, the presets and valid custom sizes round-trip unchanged', () => {
    for (const size of [...SIZE_PRESETS, '2560x1440', '1536x640', '3072x1024']) expect(snapSize(size)).toBe(size)
  })

  test('the observed regression: 1254x1254 (a 1024 reference on auto) snaps to a valid size', () => {
    expect(validateSize('1254x1254')).toContain('multiples of 16')
    expect(snapSize('1254x1254')).toBe('1248x1248')
  })

  test('the invariant: snapping any WxH yields a size the endpoint accepts', () => {
    let seed = 12345
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32
      return seed / 2 ** 32
    }
    for (let i = 0; i < 3000; i++) {
      const w = 10 + Math.floor(next() * 9990)
      const h = 10 + Math.floor(next() * 9990)
      const size = `${w}x${h}`
      const snapped = snapSize(size)
      expect(validateSize(snapped)).toBeNull()
    }
  })

  test('unparseable input falls back to auto; each rule names itself', () => {
    expect(snapSize('wide')).toBe('auto')
    expect(validateSize('1000x1000')).toContain('multiples of 16')
    expect(validateSize('4000x1024')).toContain('3839')
    expect(validateSize('3840x1280')).toContain('3839')
    expect(validateSize('2048x512')).toContain('aspect ratio')
    expect(validateSize('512x512')).toContain('pixel count')
  })
})

describe('png reading', () => {
  test('width, height and the alpha channel come from the header', () => {
    expect(readPng(pngFixture(12, 7, { kind: 'rgba' }))).toEqual({ width: 12, height: 7, hasAlpha: true })
    expect(readPng(pngFixture(12, 7, { kind: 'rgb' }))).toEqual({ width: 12, height: 7, hasAlpha: false })
    expect(readPng(pngFixture(5, 5, { kind: 'palette' }))).toEqual({ width: 5, height: 5, hasAlpha: true })
  })

  test('bytes that are not a PNG have no info', () => {
    expect(readPng(new TextEncoder().encode('not a png at all, not at all, not at all'))).toBeNull()
    expect(readPng(pngFixture(4, 4).slice(0, 20))).toBeNull()
  })

  test('magic bytes: png, jpeg and webp are told apart', async () => {
    expect(magicBytesValid(png, 'png')).toBe(true)
    expect(magicBytesValid(png, 'jpeg')).toBe(false)
    expect(magicBytesValid(await webpFixture(8, 8), 'webp')).toBe(true)
    expect(magicBytesValid(await webpFixture(8, 8), 'png')).toBe(false)
  })
})
