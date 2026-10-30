// The host process booted for real (Postgres, HTTP on port 0) with the image door mounted and a fake upstream fetch:
// auth, the path restriction, the studio wire (JSON, multipart, SSE), the failure mapping and the one run per request.
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { EnhanceOutput } from '@agent-workflows/capabilities'
import { b64, pngFixture } from '../../capabilities/src/image/testing.ts'
import type { Runtime } from '@agent-workflows/runtime'
import { bootProcess, type RunningHost } from '../src/boot.ts'
import { hostProcess } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import {
  errorResponseSchema,
  generateResponseSchema,
  moderationErrorResponseSchema,
  planResponseSchema,
  streamEventSchema,
} from '../src/image-door/contract.ts'
import type { StepIo } from '../src/image-door/index.ts'
import { freshSchema, inspector, PG_URL, SECRET, until } from './support.ts'

const STUDIO = 'studio-token-0123456789abcdef-0123456789'
const OTHER = 'other-token-0123456789abcdef-0123456789a'
const FLARE = 'gpt-image-2.5-flare'
const SUNBURST = 'gpt-image-2.5-sunburst'

const db = freshSchema('imgdoor')
const sql = inspector(db.schema)
const png = pngFixture(8, 8)
const PNG_B64 = b64(png)
const usage = { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }
const COST = (100 * 5 + 1000 * 30) / 1e6

// --- the fake upstream ---

interface Seen {
  url: string
  headers: Headers
  json?: Record<string, unknown>
  form?: FormData
  signal: AbortSignal | undefined
}
type Handler = (seen: Seen) => Response | Promise<Response>

let handler: Handler = () => new Response('no handler', { status: 500 })
const upstream: Seen[] = []
const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const body = init.body
  const seen: Seen = {
    url,
    headers: new Headers(init.headers),
    signal: init.signal ?? undefined,
    ...(typeof body === 'string' ? { json: JSON.parse(body) as Record<string, unknown> } : {}),
    ...(body instanceof FormData ? { form: body } : {}),
  }
  upstream.push(seen)
  return handler(seen)
}

const answer =
  (extra: Record<string, unknown> = {}): Handler =>
  () =>
    Response.json({ created: 1_790_000_000, data: [{ b64_json: PNG_B64 }], usage, ...extra })

const frame = (event: string, data: Record<string, unknown>) =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
const partialFrame = (index: number) =>
  frame('image_generation.partial_image', { b64_json: PNG_B64, partial_image_index: index })
const completedFrame = () => frame('image_generation.completed', { b64_json: PNG_B64, usage })
const sseAnswer =
  (...frames: string[]): Handler =>
  () =>
    new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })

const WRAPPED_MODERATION = `[OpenAI Vendor Group Key StatusCode: BadRequest] ${JSON.stringify({
  error: {
    message: 'Your request was rejected by the safety system.',
    type: 'image_generation_user_error',
    code: 'moderation_blocked',
    moderation_details: { moderation_stage: 'input', categories: ['violence', 'self-harm'] },
  },
})}`

// --- the fake planner ---

const planned: EnhanceOutput = {
  intent: { detected: 'painterly', confidence: 0.8 },
  prompt: 'Oil painting of a lighthouse at dusk in winter.',
  additions: [{ slot: 'lighting', text: 'soft north-light' }],
  verbatimCheck: { ok: true, missing: [] },
  assumptions: ['routed'],
  settings: {
    endpoint: 'edit',
    model: 'sunburst',
    size: '1024x1024',
    quality: 'high',
    background: 'opaque',
    n: 1,
    moderation: 'low',
    partialImages: 1,
  },
  estimatedCost: { perImageUsd: 0.05, totalUsd: 0.05 },
  warnings: [],
  modeApplied: 'gaps',
  playbookVersion: '2026-09-23.2',
  enhanceModel: 'gpt-6-luna',
}
const enhanced: { input: unknown; io: StepIo }[] = []
let plan: () => EnhanceOutput = () => planned

// --- the host ---

/** Read by the door on every request: tests lower the in-flight cap and the upload deadline and put them back. */
const limits = { uploadDeadlineMs: 5_000, maxInFlight: 4 }

let host: RunningHost
let runtime: Runtime
let workflows: ReturnType<typeof Array.prototype.slice> = []
let base = ''

const config = loadConfig({
  AGW_API_SECRET: SECRET,
  AGW_MACHINE: 'test-machine',
  AGW_PG_URL: PG_URL,
  AGW_PG_SCHEMA: db.schema,
  AGW_PORT: '0',
  HOME: tmpdir(),
})

const started = (async () => {
  const definition = hostProcess(config, {
    tokens: new Map([
      ['studio', STUDIO],
      ['other', OTHER],
    ]),
    limits,
    image: {
      env: { IU_API_KEY: 'test-key', IU_BASE_URL: 'https://iu.example.com/anthropic' },
      fetch: fakeFetch,
      retry: { backoffMs: 0 },
    },
    enhance: async (input, io) => {
      enhanced.push({ input, io })
      io.addUsage({
        model: 'gpt-6-luna',
        tokens: { input: 50, output: 20, cacheRead: 0, reasoning: 0 },
        cost: 0.001,
        costSource: 'rate',
      })
      return plan()
    },
  })
  const routes = definition.routes?.bind(definition)
  definition.routes = (process) => {
    runtime = process.runtime
    workflows = [...process.workflows]
    return routes?.(process) ?? []
  }
  host = await bootProcess(definition, config)
  base = `http://127.0.0.1:${host.port}`
})()

afterAll(async () => {
  await started.catch(() => undefined)
  await host?.shutdown()
  await sql.close()
  await db.drop()
})

beforeEach(async () => {
  await started
  upstream.length = 0
  enhanced.length = 0
  handler = () => new Response('no handler', { status: 500 })
  plan = () => planned
  limits.uploadDeadlineMs = 5_000
  limits.maxInFlight = 4
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const post = (path: string, body: unknown, token = STUDIO, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const generate = (body: unknown, token = STUDIO) => post('/door/image/generate', body, token)

async function runOf(response: Response, status: 'done' | 'failed' = 'done') {
  const runId = response.headers.get('agw-run-id') as string
  expect(runId).toMatch(/^[0-9a-f-]{36}$/)
  const row = await until(async () => {
    const found = await sql.run(runId)
    return found?.status === status ? found : undefined
  }, `run ${runId} ${status}`)
  return { runId, row }
}

const readFrames = async (response: Response) =>
  (await response.text())
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      expect(chunk.startsWith('data: ')).toBe(true)
      return streamEventSchema.parse(JSON.parse(chunk.slice('data: '.length)))
    })

const file = (name: string, bytes: Uint8Array<ArrayBuffer>, type = 'image/png') => new File([bytes], name, { type })
function editForm(fields: Record<string, string>, images: File[], mask?: File, field = 'image[]') {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  for (const image of images) form.append(images.length > 1 ? field : 'image', image)
  if (mask) form.append('mask', mask)
  return form
}
const edit = (form: FormData | BodyInit, token = STUDIO) =>
  fetch(`${base}/door/image/edit`, { method: 'POST', headers: bearer(token), body: form })

describe('auth', () => {
  test('no credential, a wrong one and a malformed header are 401 with the challenge and the studio envelope', async () => {
    for (const headers of [{}, bearer('wrong-token-0123456789abcdef-0123456789'), { authorization: STUDIO }]) {
      const res = await fetch(`${base}/door/image/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ prompt: 'x' }),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      expect(errorResponseSchema.parse(await res.json()).error.message).toBe('unauthorized')
    }
    expect(upstream).toHaveLength(0)
  })

  test('every door token and the platform secret are accepted, each recorded under its own name', async () => {
    handler = answer()
    const names = new Map<string, string>()
    for (const [name, token] of [
      ['studio', STUDIO],
      ['other', OTHER],
      ['agw', SECRET],
    ] as const) {
      const res = await generate({ prompt: 'a lighthouse' }, token)
      expect(res.status).toBe(200)
      names.set(name, (await runOf(res)).row.caller as string)
    }
    expect([...names]).toEqual([
      ['studio', 'studio'],
      ['other', 'other'],
      ['agw', 'agw'],
    ])
  })

  test('the caller comes from the credential: a client x-agw-caller header changes nothing', async () => {
    handler = answer()
    const res = await post('/door/image/generate', { prompt: 'x' }, STUDIO, {
      'x-agw-caller': 'hermes',
      'x-agw-project': 'someone-elses',
    })
    expect(res.status).toBe(200)
    expect((await runOf(res)).row).toMatchObject({ caller: 'studio', project: null })
  })

  test('a door token is not an API credential: the API refuses it, /health stays public and says nothing more', async () => {
    for (const [method, path] of [
      ['POST', '/workflows/smoke/ping'],
      ['GET', '/openapi.json'],
      ['GET', '/runs/00000000-0000-7000-8000-000000000000'],
      ['POST', '/image/generate'],
      ['GET', '/workflows'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: bearer(STUDIO) })
      expect({ path, status: res.status }).toEqual({ path, status: 401 })
    }
    const health = await fetch(`${base}/health`, { headers: bearer(STUDIO) })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual(await (await fetch(`${base}/health`)).json())
  })

  test('the door accepts no API path: everything else under /door is a 404, with or without a credential', async () => {
    for (const path of [
      '/door',
      '/door/',
      '/door/image',
      '/door/image/other',
      '/door/image/generate/',
      '/door/image/Generate',
      '/door/workflows/smoke/ping',
      '/door/openapi.json',
      '/door/health',
      '/door/runs/x',
    ]) {
      for (const headers of [{}, bearer(STUDIO), bearer(SECRET)]) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' })
        expect({ path, status: res.status }).toEqual({ path, status: 404 })
        errorResponseSchema.parse(await res.json())
      }
    }
    expect(upstream).toHaveLength(0)
  })

  test('a known door path with another method is a 405 naming POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/door/image/generate`, { method, headers: bearer(STUDIO) })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

describe('POST /door/image/generate', () => {
  test('the envelope parses against the studio contract, and the run carries the usage, the cost and the caller', async () => {
    handler = answer()
    const res = await generate({ prompt: 'a lighthouse at dusk', size: '1024x1024', quality: 'low' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = generateResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      created: 1_790_000_000,
      model: FLARE,
      requested_model: 'auto',
      routed: true,
      routing_reason: `routed to ${FLARE} for a low-quality draft`,
      images: [{ b64_json: PNG_B64, format: 'png' }],
      size: '1024x1024',
      quality: 'low',
      background: 'auto',
      usage: { input_tokens: 100, output_tokens: 1000, total_tokens: 1100 },
    })
    expect(body.cost.source).toBe('computed')
    expect(body.cost.usd).toBeCloseTo(COST, 8)

    const sent = upstream[0]
    expect(sent?.url).toBe('https://iu.example.com/openai/v1/images/generations')
    expect(sent?.json).toMatchObject({ prompt: 'a lighthouse at dusk', size: '1024x1024', quality: 'low', n: 1 })
    expect(sent?.json).not.toHaveProperty('stream')
    expect(sent?.headers.get('x-agw-caller')).toBeNull()

    const { runId, row } = await runOf(res)
    expect(row).toMatchObject({ workflow: 'door.image.generate', caller: 'studio' })
    expect(row.input).toMatchObject({
      caller: 'studio',
      endpoint: 'generate',
      path: '/door/image/generate',
      request: { prompt: 'a lighthouse at dusk', quality: 'low', partial_images: 0 },
    })
    expect(JSON.stringify(row.input)).not.toContain(PNG_B64)
    expect(row.output).toMatchObject({
      status: 200,
      ended: 'done',
      model: FLARE,
      images: 1,
      bytes: png.length,
      partials: 0,
    })
    expect((row.output as { costUsd: number }).costUsd).toBeCloseTo(COST, 8)
    const step = await sql.step(runId, 'serve')
    expect(Number(step?.cost)).toBeCloseTo(COST, 8)
    expect(Number(step?.tokens_input)).toBe(100)
    expect(Number(step?.tokens_output)).toBe(1000)
  })

  test('an explicit model is honoured and not reported as routed; the retired id is routed and says so', async () => {
    handler = answer()
    const explicit = generateResponseSchema.parse(
      await (await generate({ prompt: 'x', model: SUNBURST, quality: 'low' })).json(),
    )
    expect(explicit).toMatchObject({ model: SUNBURST, requested_model: SUNBURST, routed: false })
    expect(explicit.routing_reason).toBeUndefined()
    expect(upstream[0]?.json?.model).toBe(SUNBURST)

    const legacy = generateResponseSchema.parse(await (await generate({ prompt: 'x', model: 'gpt-image-2' })).json())
    expect(legacy).toMatchObject({
      model: FLARE,
      requested_model: 'gpt-image-2',
      routed: true,
      routing_reason: `gpt-image-2 is retired — routed to ${FLARE} for a default-quality draft`,
    })
    const final = generateResponseSchema.parse(await (await generate({ prompt: 'x', quality: 'xhigh' })).json())
    expect(final.model).toBe(SUNBURST)
  })

  test('output_compression and moderation reach the upstream call', async () => {
    handler = answer()
    await generate({ prompt: 'x', output_format: 'webp', output_compression: 70, moderation: 'low' })
    // a webp request: the fake answers a png, so the envelope is the failure; the request is what is asserted
    expect(upstream[0]?.json).toMatchObject({ output_format: 'webp', output_compression: 70, moderation: 'low' })
  })

  test('requests the studio refuses are 400 with the envelope, before any run or upstream call', async () => {
    const bad: [string, unknown, string][] = [
      ['an empty prompt', { prompt: '' }, ''],
      ['streaming with n above 1', { prompt: 'x', n: 2, partial_images: 1 }, 'streaming (partial_images > 0)'],
      ['a size outside the envelope', { prompt: 'x', size: '100x100' }, ''],
      ['a transparent jpeg', { prompt: 'x', background: 'transparent', output_format: 'jpeg' }, 'jpeg has no alpha'],
      ['not JSON', '{nope', 'not valid JSON'],
      ['an unknown model', { prompt: 'x', model: 'gpt-image-1.5' }, ''],
    ]
    const before = (await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)).rows[0].n
    for (const [, body, message] of bad) {
      const res = await generate(body)
      expect(res.status).toBe(400)
      expect(res.headers.get('agw-run-id')).toBeNull()
      expect(errorResponseSchema.parse(await res.json()).error.message).toContain(message)
    }
    expect(upstream).toHaveLength(0)
    expect((await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)).rows[0].n).toBe(before)
  })

  test('a body over the JSON cap is 413 with the envelope and is not read', async () => {
    const res = await generate(`{"prompt":"${'x'.repeat(3 * 1024 * 1024)}"}`)
    expect(res.status).toBe(413)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('over')
    expect(upstream).toHaveLength(0)
  })

  test('an upstream failure is a 502 upstream_error with the vendor message, and the run failed', async () => {
    handler = () => Response.json({ error: { message: 'model overloaded' } }, { status: 500 })
    const res = await generate({ prompt: 'x' })
    expect(res.status).toBe(502)
    const body = errorResponseSchema.parse(await res.json())
    expect(body.error.type).toBe('upstream_error')
    const { row } = await runOf(res, 'failed')
    expect(String(row.error)).toContain('502 upstream_error')
  })

  test('a moderation block is a 502 whose body carries the code and the stage and categories', async () => {
    handler = () => new Response(WRAPPED_MODERATION, { status: 503 })
    const res = await generate({ prompt: 'x' })
    expect(res.status).toBe(502)
    expect(moderationErrorResponseSchema.parse(await res.json())).toEqual({
      error: {
        message: 'Your request was rejected by the safety system.',
        type: 'upstream_error',
        code: 'moderation_blocked',
        moderation_details: { moderation_stage: 'input', categories: ['violence', 'self-harm'] },
      },
    })
    expect(upstream).toHaveLength(1) // a wrapped user error is never retried
  })
})

describe('POST /door/image/edit', () => {
  const fields = { prompt: 'remove the boat', quality: 'low' }

  test('one reference and a mask: multipart to /images/edits, the envelope is sunburst and the run keeps no bytes', async () => {
    handler = answer()
    const mask = file('mask.png', new Uint8Array(png))
    const res = await edit(editForm(fields, [file('boat.png', new Uint8Array(png))], mask))
    expect(res.status).toBe(200)
    const body = generateResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      model: SUNBURST,
      routed: true,
      routing_reason: `routed to ${SUNBURST} for editing/reference precision`,
    })
    const sent = upstream[0]
    expect(sent?.url).toBe('https://iu.example.com/openai/v1/images/edits')
    expect(sent?.form?.getAll('image')).toHaveLength(1)
    expect(sent?.form?.has('image[]')).toBe(false)
    expect((sent?.form?.get('mask') as File | null)?.name).toBe('mask.png')
    expect(sent?.form?.get('prompt')).toBe('remove the boat')

    const { row } = await runOf(res)
    expect(row.input).toMatchObject({
      endpoint: 'edit',
      request: {
        prompt: 'remove the boat',
        images: [{ name: 'boat.png', mime: 'image/png', bytes: png.length }],
        mask: { name: 'mask.png', mime: 'image/png', bytes: png.length },
      },
    })
    expect(JSON.stringify(row.input)).not.toContain(Buffer.from(png).toString('latin1'))
    expect(row.output).toMatchObject({ status: 200, ended: 'done', model: SUNBURST })
  })

  test('two references travel as image[] in the order sent, a jpeg among them', async () => {
    handler = answer()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const res = await edit(editForm(fields, [file('a.png', new Uint8Array(png)), file('b.jpg', jpeg, 'image/jpeg')]))
    expect(res.status).toBe(200)
    const sent = upstream[0]?.form?.getAll('image[]') as File[]
    expect(sent.map((f) => f.name)).toEqual(['a.png', 'b.jpg'])
    expect(sent.map((f) => f.type)).toEqual(['image/png', 'image/jpeg'])
    expect(upstream[0]?.form?.has('image')).toBe(false)
    expect((await runOf(res)).row.input).toMatchObject({ request: { images: [{ name: 'a.png' }, { name: 'b.jpg' }] } })
  })

  test('the refusals of the studio, in its words: no image, a wrong mime, a mask that is not a png, bad fields, garbage', async () => {
    const cases: [string, FormData | BodyInit, string][] = [
      ['no image', editForm(fields, []), 'at least one reference image is required'],
      ['a gif', editForm(fields, [file('a.gif', new Uint8Array(png), 'image/gif')]), 'reference images must be one of'],
      [
        'a jpeg mask',
        editForm(fields, [file('a.png', new Uint8Array(png))], file('m.jpg', new Uint8Array(png), 'image/jpeg')),
        'mask must be image/png',
      ],
      [
        'streaming with n=2',
        editForm({ ...fields, n: '2', partial_images: '1' }, [file('a.png', new Uint8Array(png))]),
        'streaming (partial_images > 0)',
      ],
      ['an empty prompt', editForm({ prompt: '' }, [file('a.png', new Uint8Array(png))]), ''],
      [
        'input_fidelity on a model without it',
        editForm({ ...fields, input_fidelity: 'high' }, [file('a.png', new Uint8Array(png))]),
        'does not support input_fidelity',
      ],
    ]
    for (const [name, form, message] of cases) {
      const res = await edit(form)
      expect({ name, status: res.status }).toEqual({ name, status: 400 })
      expect(errorResponseSchema.parse(await res.json()).error.message).toContain(message)
    }
    const garbage = await fetch(`${base}/door/image/edit`, {
      method: 'POST',
      headers: { ...bearer(STUDIO), 'content-type': 'multipart/form-data; boundary=nope' },
      body: 'this is not multipart',
    })
    expect(garbage.status).toBe(400)
    const notMultipart = await fetch(`${base}/door/image/edit`, {
      method: 'POST',
      headers: { ...bearer(STUDIO), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(notMultipart.status).toBe(400)
    expect(upstream).toHaveLength(0)
  })

  test('a reference over 50 MB is 400 and a request over the total cap is 413, neither reaches upstream', async () => {
    const big = file('big.png', new Uint8Array(51 * 1024 * 1024))
    const tooBig = await edit(editForm(fields, [big]))
    expect(tooBig.status).toBe(400)
    expect(errorResponseSchema.parse(await tooBig.json()).error.message).toContain('at most 52428800 bytes')

    const huge = await edit(editForm(fields, [file('a.png', new Uint8Array(101 * 1024 * 1024))]))
    expect(huge.status).toBe(413)
    expect(errorResponseSchema.parse(await huge.json()).error.message).toContain('over')
    expect(upstream).toHaveLength(0)
  })
})

describe('streaming', () => {
  test('previews as they arrive, then exactly one completed frame, with the SSE headers and the run id', async () => {
    handler = sseAnswer(partialFrame(0), partialFrame(1), completedFrame())
    const res = await generate({ prompt: 'a lighthouse', partial_images: 2 })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const frames = await readFrames(res)
    expect(frames.map((f) => f.type)).toEqual(['partial_image', 'partial_image', 'completed'])
    expect(frames.map((f) => (f.type === 'partial_image' ? f.partial_image_index : -1))).toEqual([0, 1, -1])
    const done = frames[2]
    if (done?.type !== 'completed') throw new Error('expected a completed frame')
    expect(done.response).toMatchObject({ model: FLARE, images: [{ b64_json: PNG_B64, format: 'png' }] })
    expect(done.response.cost.usd).toBeCloseTo(COST, 8)
    expect(upstream[0]?.json).toMatchObject({ stream: true, partial_images: 2 })

    const { row } = await runOf(res)
    expect(row.output).toMatchObject({ status: 200, ended: 'done', images: 1, partials: 2 })
  })

  test('an edit streams the same way (image_edit.* upstream events)', async () => {
    const ns = (event: string, data: Record<string, unknown>) =>
      `event: image_edit.${event}\ndata: ${JSON.stringify({ type: `image_edit.${event}`, ...data })}\n\n`
    handler = sseAnswer(
      ns('partial_image', { b64_json: PNG_B64, partial_image_index: 0 }),
      ns('completed', { b64_json: PNG_B64, usage }),
    )
    const form = editForm({ prompt: 'x', partial_images: '1' }, [file('a.png', new Uint8Array(png))])
    const res = await edit(form)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect((await readFrames(res)).map((f) => f.type)).toEqual(['partial_image', 'completed'])
  })

  test('fewer previews than asked is normal: a stream with no preview is just the completed frame', async () => {
    handler = sseAnswer(completedFrame())
    const res = await generate({ prompt: 'x', partial_images: 3 })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect((await readFrames(res)).map((f) => f.type)).toEqual(['completed'])
  })

  test('an error after a preview is exactly one error frame, and the run failed', async () => {
    handler = sseAnswer(partialFrame(0), frame('image_generation.error', { error: { message: 'blocked at output' } }))
    const res = await generate({ prompt: 'x', partial_images: 1 })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const frames = await readFrames(res)
    expect(frames.map((f) => f.type)).toEqual(['partial_image', 'error'])
    expect(frames[1]).toEqual({ type: 'error', error: { message: 'blocked at output', type: 'upstream_error' } })
    const { row } = await runOf(res, 'failed')
    expect(String(row.error)).toContain('blocked at output')
  })

  test('a stream that ends without a completed frame is one error frame', async () => {
    handler = sseAnswer(partialFrame(0))
    const frames = await readFrames(await generate({ prompt: 'x', partial_images: 1 }))
    expect(frames.map((f) => f.type)).toEqual(['partial_image', 'error'])
  })

  test('a failure before any byte is a plain JSON error with its status, not a stream', async () => {
    handler = () => Response.json({ error: { message: 'overloaded' } }, { status: 500 })
    const res = await generate({ prompt: 'x', partial_images: 1 })
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(errorResponseSchema.parse(await res.json()).error.type).toBe('upstream_error')
    expect(upstream).toHaveLength(3) // the endpoint's own retry set, before any byte

    handler = () => new Response(WRAPPED_MODERATION, { status: 503 })
    const blocked = await generate({ prompt: 'x', partial_images: 1 })
    expect(blocked.status).toBe(502)
    expect(moderationErrorResponseSchema.parse(await blocked.json()).error.code).toBe('moderation_blocked')
  })

  test('the client going away cancels the upstream call, ends the run client-gone and bills nothing', async () => {
    let upstreamSignal: AbortSignal | undefined
    handler = ({ signal }) => {
      upstreamSignal = signal
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(partialFrame(0)))
            // then silence: the completed frame never comes. Like a real body, it fails when the call is aborted.
            signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const controller = new AbortController()
    const res = await fetch(`${base}/door/image/generate`, {
      method: 'POST',
      headers: { ...bearer(STUDIO), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', partial_images: 1 }),
      signal: controller.signal,
    })
    const runId = res.headers.get('agw-run-id') as string
    const reader = res.body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain('"partial_image"')
    controller.abort()
    await reader?.cancel().catch(() => undefined)

    await until(() => upstreamSignal?.aborted, 'the upstream call aborted')
    const row = await until(async () => {
      const found = await sql.run(runId)
      return found?.status === 'done' ? found : undefined
    }, 'the run ended')
    expect(row.output).toMatchObject({ status: 499, ended: 'client-gone', images: 0, costUsd: null, partials: 1 })
    const step = await sql.step(runId, 'serve')
    expect(Number(step?.tokens_input)).toBe(0)
    expect(step?.cost === null || Number(step?.cost) === 0).toBe(true)
    expect(upstream).toHaveLength(1) // never sent again
  })
})

describe('POST /door/image/enhance', () => {
  const request = {
    current_prompt: 'a lighthouse at dusk, oil painting',
    delta: 'make it winter',
    mode: 'gaps',
    intent: 'painterly',
    overrides: { model: SUNBURST, quality: 'high', input_fidelity: 'high', partial_images: 0, n: 2 },
    style_guide: { prompt_fragment: 'soft north-light', palette: ['#1b4d5c'], avoid: ['neon'], ref_image_count: 2 },
    series_context: [{ prompt: 'a harbour at dawn', settings: { size: '1024x1024' } }],
    preserve_list: ['the red lamp'],
    has_references: true,
  }

  test('the plan request reaches the planner mapped to its camelCase input, the plan answers in the studio shape', async () => {
    const res = await post('/door/image/enhance', request)
    expect(res.status).toBe(200)
    const body = planResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      prompt: planned.prompt,
      verbatim_check: { ok: true, missing: [] },
      settings: { endpoint: 'edit', model: SUNBURST, moderation: 'low', partial_images: 1 },
      estimated_cost: { per_image_usd: 0.05, total_usd: 0.05 },
      mode_applied: 'gaps',
      playbook_version: '2026-09-23.2',
      enhance_model: 'gpt-6-luna',
    })
    expect(body.settings).not.toHaveProperty('input_fidelity')
    expect(enhanced[0]?.input).toEqual({
      currentPrompt: 'a lighthouse at dusk, oil painting',
      delta: 'make it winter',
      hasReferences: true,
      intent: 'painterly',
      mode: 'gaps',
      overrides: { model: 'sunburst', quality: 'high', inputFidelity: 'high', partialImages: 0, n: 2 },
      styleGuide: { promptFragment: 'soft north-light', palette: ['#1b4d5c'], avoid: ['neon'], refImageCount: 2 },
      seriesContext: [{ prompt: 'a harbour at dawn', settings: { size: '1024x1024' } }],
      preserveList: ['the red lamp'],
    })

    const { runId, row } = await runOf(res)
    expect(row).toMatchObject({ workflow: 'door.image.enhance', caller: 'studio' })
    expect(row.input).toMatchObject({ endpoint: 'enhance', request: { delta: 'make it winter' } })
    expect(row.output).toMatchObject({ status: 200, ended: 'done', model: 'gpt-6-luna', images: 0 })
    expect(Number((await sql.step(runId, 'serve'))?.cost)).toBeCloseTo(0.001, 8)
  })

  test('a brief maps with its defaults; pinned model "auto" stays auto; no override block is invented', async () => {
    await post('/door/image/enhance', { brief: 'a lighthouse', overrides: { model: 'auto' } })
    await post('/door/image/enhance', { brief: 'a lighthouse' })
    expect(enhanced[0]?.input).toEqual({
      brief: 'a lighthouse',
      hasReferences: false,
      intent: 'auto',
      mode: 'auto',
      overrides: { model: 'auto' },
      seriesContext: [],
      preserveList: [],
    })
    expect(enhanced[1]?.input).not.toHaveProperty('overrides')
  })

  test('an unpriced plan reports 0, the planner failing is a 502, a bad request is a 400', async () => {
    plan = () => ({ ...planned, estimatedCost: null })
    expect(
      planResponseSchema.parse(await (await post('/door/image/enhance', { brief: 'x' })).json()).estimated_cost,
    ).toEqual({
      per_image_usd: 0,
      total_usd: 0,
    })
    const invalid = await post('/door/image/enhance', { brief: 'x', current_prompt: 'y' })
    expect(invalid.status).toBe(400)
    expect(errorResponseSchema.parse(await invalid.json()).error.message).toContain(
      'exactly one of brief or current_prompt',
    )
    const oversized = await post('/door/image/enhance', `{"brief":"${'x'.repeat(3 * 1024 * 1024)}"}`)
    expect(oversized.status).toBe(413)
  })
})

describe('the run of a request', () => {
  test('resumed in a process that never served it, the run fails with a clear message', async () => {
    const door = workflows.find((entry) => entry.workflow.id === 'door.image.generate')
    if (!door) throw new Error('the door workflow is not registered')
    const { runId } = await runtime.start(
      door.workflow,
      {
        caller: 'studio',
        endpoint: 'generate',
        path: '/door/image/generate',
        request: { prompt: 'x' },
      },
      { purpose: 'test' },
    )
    const row = await until(async () => {
      const found = await sql.run(runId)
      return found?.status === 'failed' ? found : undefined
    }, 'the orphan run failed')
    expect(String(row.error)).toContain('served by a process that has stopped')
  })

  test('the door workflows have no API route, no CLI command and no schema entry', async () => {
    const doc = (await (await fetch(`${base}/openapi.json`, { headers: bearer(SECRET) })).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths).filter((path) => path.includes('door'))).toEqual([])
    const res = await fetch(`${base}/workflows/door/image/generate`, { method: 'POST', headers: bearer(SECRET) })
    expect(res.status).toBe(404)
  })
})

describe('request fields', () => {
  test('unknown fields are ignored, as the studio schemas do (a misspelled partial_image changes nothing)', async () => {
    handler = answer()
    const res = await generate({ prompt: 'x', partial_image: 2, surprise: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(upstream[0]?.json).not.toHaveProperty('stream')
    expect(upstream[0]?.json).not.toHaveProperty('surprise')
    const { row } = await runOf(res)
    expect(JSON.stringify(row.input)).not.toContain('surprise')
  })

  test('a purpose the run cannot be started with is a 400 before the body is read: no run, no upstream call', async () => {
    const before = (await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)).rows[0].n
    const res = await post('/door/image/generate', { prompt: 'x' }, STUDIO, { 'x-agw-purpose': 'not valid!' })
    expect(res.status).toBe(400)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('x-agw-purpose')
    expect(upstream).toHaveLength(0)
    expect((await sql.pool.query(`select count(*)::int as n from "${db.schema}".runs`)).rows[0].n).toBe(before)

    handler = answer()
    const ok = await post('/door/image/generate', { prompt: 'x' }, STUDIO, { 'x-agw-purpose': 'verify' })
    expect((await runOf(ok)).row.purpose).toBe('verify')
  })
})

describe('failures the client is told about, and the ones it is not', () => {
  test('a transport failure is a generic 502 for the client; its text is logged with the run id', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      handler = () => {
        throw new TypeError('fetch failed: connect ECONNRESET 10.1.2.3:443')
      }
      const res = await generate({ prompt: 'x' })
      expect(res.status).toBe(502)
      const text = JSON.stringify(await res.json())
      expect(text).toContain('upstream unavailable')
      expect(text).not.toContain('10.1.2.3')
      const { runId, row } = await runOf(res, 'failed')
      expect(String(row.error)).not.toContain('10.1.2.3')
      const lines = logged.mock.calls
        .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
        .join('\n')
      expect(lines).toContain(runId)
      expect(lines).toContain('10.1.2.3')
    } finally {
      logged.mockRestore()
    }
  })

  test('a mid-stream moderation block reaches the final error frame with its code and details', async () => {
    handler = sseAnswer(
      partialFrame(0),
      frame('image_generation.error', {
        error: {
          message: 'Blocked at the output stage.',
          code: 'moderation_blocked',
          moderation_details: { moderation_stage: 'output', categories: ['violence'] },
        },
      }),
    )
    // raw frames: the studio's own event schema would strip the extra keys, which the app reads when they are there
    const text = await (await generate({ prompt: 'x', partial_images: 1 })).text()
    const frames = text
      .split('\n\n')
      .filter((chunk) => chunk.trim() !== '')
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>)
    expect(frames.map((f) => f.type)).toEqual(['partial_image', 'error'])
    expect(frames[1]).toEqual({
      type: 'error',
      error: {
        message: 'Blocked at the output stage.',
        type: 'upstream_error',
        code: 'moderation_blocked',
        moderation_details: { moderation_stage: 'output', categories: ['violence'] },
      },
    })
  })

  test('a block naming only a stage still carries details: the missing half is empty', async () => {
    const wrapped = `[OpenAI Vendor Group Key StatusCode: BadRequest] ${JSON.stringify({
      error: {
        message: 'blocked',
        type: 'image_generation_user_error',
        code: 'moderation_blocked',
        moderation_details: { moderation_stage: 'input' },
      },
    })}`
    handler = () => new Response(wrapped, { status: 503 })
    const res = await generate({ prompt: 'x' })
    expect(moderationErrorResponseSchema.parse(await res.json()).error.moderation_details).toEqual({
      moderation_stage: 'input',
      categories: [],
    })
  })
})

describe('limits on what is in flight', () => {
  /** An upstream call that waits until its call is aborted, like a real slow one. */
  const hang: Handler = ({ signal }) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  test('an upload that does not finish in time is a 408 with the envelope, and its slot is freed', async () => {
    limits.uploadDeadlineMs = 300
    const encoder = new TextEncoder()
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"prompt":"x'))
      },
    })
    const res = await fetch(`${base}/door/image/generate`, {
      method: 'POST',
      headers: { ...bearer(STUDIO), 'content-type': 'application/json' },
      body: stalled,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(408)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('not received in time')
    expect(upstream).toHaveLength(0)

    limits.maxInFlight = 1
    handler = answer()
    expect((await generate({ prompt: 'x' })).status).toBe(200) // the stalled upload's slot was given back
  })

  test('a client that leaves during the upload starts nothing, and its slot is freed', async () => {
    limits.maxInFlight = 1
    const encoder = new TextEncoder()
    const controller = new AbortController()
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"prompt":"x'))
      },
    })
    const sent = fetch(`${base}/door/image/generate`, {
      method: 'POST',
      headers: { ...bearer(STUDIO), 'content-type': 'application/json' },
      body: stalled,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit).catch(() => undefined)
    await Bun.sleep(100)
    // the upload holds the only slot
    expect((await generate({ prompt: 'x' })).status).toBe(503)
    controller.abort()
    await sent
    handler = answer()
    const next = await until(async () => {
      const res = await generate({ prompt: 'x' })
      return res.status === 200 ? res : undefined
    }, 'the slot freed')
    expect(next.status).toBe(200)
    expect(upstream).toHaveLength(1) // only the later request reached upstream
  })

  test('the fifth request in flight is a 503 proxy_error with retry-after; slots come back as requests end', async () => {
    handler = hang
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const held = controllers.map((c) =>
      fetch(`${base}/door/image/generate`, {
        method: 'POST',
        headers: { ...bearer(STUDIO), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
        signal: c.signal,
      }).catch(() => undefined),
    )
    await until(() => upstream.length === 4, 'four calls in flight')
    const fifth = await generate({ prompt: 'x' })
    expect(fifth.status).toBe(503)
    expect(fifth.headers.get('retry-after')).toBe('5')
    expect(errorResponseSchema.parse(await fifth.json()).error.type).toBe('proxy_error')
    expect(upstream).toHaveLength(4)

    handler = answer()
    controllers[0]?.abort()
    const again = await until(async () => {
      const res = await generate({ prompt: 'x' })
      return res.status === 200 ? res : undefined
    }, 'a slot freed by an abort')
    expect(again.status).toBe(200)
    for (const c of controllers) c.abort()
    await Promise.all(held)
  })

  test('a stream the client cancels, and one that ends or fails, give their slot back', async () => {
    limits.maxInFlight = 1
    const silentStream: Handler = ({ signal }) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(partialFrame(0)))
            signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    handler = silentStream
    const res = await generate({ prompt: 'x', partial_images: 1 })
    const reader = res.body?.getReader()
    await reader?.read()
    expect((await generate({ prompt: 'x' })).status).toBe(503) // the open stream holds the slot
    await reader?.cancel()
    handler = sseAnswer(partialFrame(0), completedFrame())
    const next = await until(async () => {
      const r = await generate({ prompt: 'x', partial_images: 1 })
      return r.headers.get('content-type') === 'text/event-stream' ? r : undefined
    }, 'the cancelled stream freed its slot')
    await readFrames(next) // ends normally
    handler = () => Response.json({ error: { message: 'boom' } }, { status: 500 })
    expect((await generate({ prompt: 'x' })).status).toBe(502) // fails
    handler = answer()
    expect((await generate({ prompt: 'x' })).status).toBe(200) // both gave the slot back
  })
})
