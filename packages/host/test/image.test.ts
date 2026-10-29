import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '@agent-workflows/capabilities'
import { IMAGE_ROUTES } from '@agent-workflows/routes'
import { createImageCapabilities } from '../../capabilities/src/image/index.ts'
import {
  b64,
  type FakeHandler,
  pngFixture,
  startFakeImageServer,
  webpFixture,
} from '../../capabilities/src/image/testing.ts'
import { createImageWorkflows, type ImageCaller } from '../src/workflows/image/index.ts'
import { imageScorer } from '../src/workflows/image/scorer.ts'
import { startTestHost, type TestHost, until } from './support.ts'

const fake = startFakeImageServer()
const root = mkdtempSync(join(tmpdir(), 'agw-image-wf-'))
const artifacts = join(root, 'artifacts')
let cdn: Record<string, Uint8Array<ArrayBuffer>> = {}

/** The image capabilities over the fake endpoint, behind the real registry; Replicate's CDN is a map inside `fetch`. */
const registry = createRegistry(
  createImageCapabilities({
    env: { IU_API_KEY: 'test-key', IU_BASE_URL: fake.baseUrl },
    retry: { backoffMs: 0 },
    pollMs: 1,
    fetch: (url, init) => {
      const hit = cdn[url]
      return hit ? Promise.resolve(new Response(hit)) : fetch(url, init)
    },
  }),
)

const handlers = new Proxy<Record<string, FakeHandler>>(
  {},
  {
    set(_target, path: string, handler: FakeHandler) {
      fake.on(path, handler)
      return true
    },
  },
)
const GEN = '/openai/v1/images/generations'
const EDIT = '/openai/v1/images/edits'
const PREDICT = (key: keyof typeof IMAGE_ROUTES) => `/replicate/v1/models/${IMAGE_ROUTES[key].model}/predictions`
const DELIVERED = 'https://replicate.delivery/out/cutout.webp'
const usage = { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }

let t: TestHost
beforeAll(async () => {
  const workflows = createImageWorkflows(
    { registry: registry as unknown as ImageCaller },
    { artifacts: { root: artifacts } },
  )
  t = await startTestHost({ prefix: 'image', platform: true, extra: workflows })
})
afterAll(async () => {
  await t.close()
  fake.stop()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  fake.reset()
  cdn = {}
})

const run = async (body: Record<string, unknown>) =>
  t.json(await t.call('/workflows/image', { method: 'POST', body, headers: { prefer: 'wait=30' } }))
const readPngSize = (path: string) => {
  const bytes = readFileSync(path)
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    signature: bytes.subarray(1, 4).toString('latin1'),
  }
}

describe('image end to end', () => {
  test('a prompt: the PNGs land in the artifact store under the run id, the output lists them, the cost is on the run record', async () => {
    const png = pngFixture(16, 12)
    handlers[GEN] = () => Response.json({ data: [{ b64_json: b64(png) }, { b64_json: b64(png) }], usage })
    const { status, body } = await run({ prompt: 'a lighthouse header', quality: 'low', n: 2, size: '1536x1024' })

    expect(status).toBe(200)
    expect(body).toMatchObject({ workflowId: 'image', status: 'done' })
    const out = body.output
    expect(out).toMatchObject({ kind: 'generate', size: '1536x1024', model: IMAGE_ROUTES['image.flare'].model })
    expect(out.generationId).toBeString()
    expect(out.dir).toBe(join(artifacts, 'image', body.runId))
    expect(out.files.map((f: { path: string }) => f.path)).toEqual([join(out.dir, '1.png'), join(out.dir, '2.png')])
    for (const file of out.files) {
      expect(readFileSync(file.path).equals(Buffer.from(png))).toBe(true)
      expect(file).toMatchObject({ bytes: png.length, width: 16, height: 12, hasAlpha: true })
    }
    expect(out.cost).toEqual({ usd: 0.0305, source: 'rate' })

    // the request the endpoint saw
    expect(fake.seen[0]?.json).toMatchObject({
      prompt: 'a lighthouse header',
      n: 2,
      size: '1536x1024',
      quality: 'low',
      output_format: 'png',
    })

    // cost recorded: on the step, in the run record, and in Argo
    const { rows } = await t.pool.query(`select * from "${t.schema}".steps where run_id = $1`, [body.runId])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      step_id: 'generate',
      kind: 'code',
      status: 'done',
      tokens_input: '100',
      tokens_output: '1000',
      unpriced_calls: 0,
    })
    expect(Number(rows[0].cost)).toBeCloseTo(0.0305, 8)
    await until(
      async () =>
        (await t.pool.query(`select post_hooks_at from "${t.schema}".runs where id = $1`, [body.runId])).rows[0]
          .post_hooks_at,
      'run record',
    )
    await t.platform?.outbox?.flush()
    const stored = [...t.argo.stored.values()].filter((r) => r.source_id.startsWith(`${body.runId}:generate`))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ sub_tool: 'image', output_tokens: 1000 })
  })

  test('an edit: reference image paths become a multipart call on the quality model, reported as an edit', async () => {
    const photo = join(root, 'photo.png')
    writeFileSync(photo, pngFixture(32, 32, { kind: 'rgb' }))
    handlers[EDIT] = () => Response.json({ data: [{ b64_json: b64(pngFixture(8, 8)) }], usage })
    const { body } = await run({ prompt: 'make it dusk', images: [photo], quality: 'low' })
    expect(body.status).toBe('done')
    expect(body.output).toMatchObject({ kind: 'edit', model: IMAGE_ROUTES['image.sunburst'].model })
    expect(fake.seen[0]?.form?.getAll('image')).toHaveLength(1)
  })

  test('a cutout: recraft’s WebP comes back a PNG with alpha in the store, priced per call', async () => {
    const source = join(root, 'subject.png')
    writeFileSync(source, pngFixture(300, 280, { kind: 'rgb' }))
    cdn[DELIVERED] = await webpFixture(300, 280)
    handlers[PREDICT('image.cutout.recraft')] = () =>
      Response.json({ id: 'p1', status: 'succeeded', output: DELIVERED })
    const { body } = await run({ file: source })

    expect(body.status).toBe('done')
    const out = body.output
    expect(out).toMatchObject({
      kind: 'cutout',
      model: IMAGE_ROUTES['image.cutout.recraft'].model,
      cost: { usd: 0.01, source: 'rate' },
    })
    expect(out.files).toHaveLength(1)
    expect(out.files[0]).toMatchObject({ path: join(out.dir, '1.png'), width: 300, height: 280, hasAlpha: true })
    expect(readPngSize(out.files[0].path)).toEqual({ width: 300, height: 280, signature: 'PNG' })

    const verdict = imageScorer.score(
      { file: source, size: 'auto', n: 1, quality: 'auto', model: 'auto', background: 'auto', images: [] },
      out,
      {
        source: 'regression',
        signal: new AbortController().signal,
      },
    )
    expect(verdict).toMatchObject({ pass: true, scores: { valid: 1, count: 1, alpha: 1, cost: 1 } })

    const { rows } = await t.pool.query(`select * from "${t.schema}".steps where run_id = $1`, [body.runId])
    expect(Number(rows[0].cost)).toBeCloseTo(0.01, 8)
  })

  test('a vendor-wrapped 400 fails the run with the vendor message, once, and writes nothing', async () => {
    handlers[GEN] = () =>
      new Response(
        '[OpenAI Vendor Group Key StatusCode: BadRequest] {"error":{"message":"Invalid value: size","type":"invalid_request_error"}}',
        { status: 503 },
      )
    const { body } = await run({ prompt: 'x' })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body.error)).toContain('Invalid value: size')
    expect(fake.seen).toHaveLength(1)
    expect(existsSync(join(artifacts, 'image', body.runId))).toBe(false)
  })

  test('a body that is not a PNG fails the run and writes nothing, but the billed call is on the run', async () => {
    handlers[GEN] = () => Response.json({ data: [{ b64_json: b64(new TextEncoder().encode('<html>')) }], usage })
    const { body } = await run({ prompt: 'x' })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body.error)).toContain('not a valid png')
    expect(existsSync(join(artifacts, 'image', body.runId))).toBe(false)
  })

  test('input that names both jobs, neither, or the wrong model for the job is a 400 before any run', async () => {
    for (const bad of [
      { prompt: 'x', file: '/abs/a.png' },
      {},
      { file: '/abs/a.png', model: 'flare' },
      { prompt: 'x', model: 'bria' },
      { file: '/abs/a.png', images: ['/abs/b.png'] },
      { prompt: 'x', n: 11 },
    ]) {
      expect((await t.call('/workflows/image', { method: 'POST', body: bad })).status).toBe(400)
    }
    expect(fake.seen).toEqual([])
  })
})
