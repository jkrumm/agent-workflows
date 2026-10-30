import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { DEFAULT_ROUTES as IMAGE_ROUTES } from '@agent-workflows/routes'
import sharp, { type Sharp } from 'sharp'
import { createImageCapabilities } from '../../capabilities/src/image/index.ts'
import { type FakeHandler, startFakeImageServer } from '../../capabilities/src/image/testing.ts'
import { createImageIconWorkflows, type ImageIconCaller } from '../src/workflows/image-icon/index.ts'
import { cleanVectorized, ICONS_MANIFEST, iconsHtml } from '../src/workflows/image-icon/pipeline.ts'
import { ImageIconInput } from '../src/workflows/image-icon/schema.ts'
import { startTestHost, type TestHost } from './support.ts'

const fake = startFakeImageServer()
const root = mkdtempSync(join(tmpdir(), 'agw-image-icon-wf-'))
const artifacts = join(root, 'artifacts')
let cdn: Record<string, Uint8Array<ArrayBuffer>> = {}

const registry = createRegistry(
  createImageCapabilities(
    {
      env: { IU_API_KEY: 'test-key', IU_BASE_URL: fake.baseUrl },
      retry: { backoffMs: 0 },
      pollMs: 1,
      fetch: (url, init) => {
        const hit = cdn[url]
        return hit ? Promise.resolve(new Response(hit)) : fetch(url, init)
      },
    },
    { transports: fakeTransports({ openai: [{ text: '' }] }), env: {} },
  ),
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
const predict = (model: string) => `/replicate/v1/models/${model}/predictions`
const UPSCALE = predict(IMAGE_ROUTES['image.upscale'].model)
const CUTOUT = predict(IMAGE_ROUTES['image.cutout.recraft'].model)
const VECTORIZE = predict(IMAGE_ROUTES['image.vectorize'].model)
const DELIVER = {
  upscale: 'https://replicate.delivery/out/upscaled.png',
  cutout: 'https://replicate.delivery/out/cutout.png',
  vectorize: 'https://replicate.delivery/out/icon.svg',
} as const

/** What recraft-vectorize emits: a fixed width/height/style on the root and a no-op translate per path. */
const RAW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" style="width:100%"><path transform="translate(0,0)" d="M100 100h800v800H100z" fill="#c83c28"/></svg>'

/** An SVG that stays over 64 KB after svgo: thousands of paths, each its own colour. */
const BIG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${Array.from(
  { length: 4000 },
  (_, i) =>
    `<path d="M${(i * 37) % 1000} ${(i * 91) % 1000}h${(i % 40) + 5}v${(i % 29) + 5}l-${(i % 7) + 1} ${(i % 11) + 2}z" fill="#${((i * 2654435) % 0xffffff).toString(16).padStart(6, '0')}"/>`,
).join('')}</svg>`

const text = (value: string) => new Uint8Array(Buffer.from(value))
const png = async (pipeline: Sharp) => new Uint8Array(await pipeline.png().toBuffer())
/** A square image: transparent canvas with an opaque square in the middle, or a flat opaque image. */
const subject = (size: number, opaque = false) =>
  png(
    opaque
      ? sharp({ create: { width: size, height: size, channels: 3, background: '#c83c28' } })
      : sharp({
          create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).composite([
          {
            input: { create: { width: size / 2, height: size / 2, channels: 4, background: '#c83c28' } },
            left: size / 4,
            top: size / 4,
          },
        ]),
  )

const writeSource = async (name: string, bytes: Uint8Array) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

const delivers = (stage: keyof typeof DELIVER, body: Uint8Array<ArrayBuffer>, path: string, id = stage) => {
  cdn[DELIVER[stage]] = body
  handlers[path] = () => Response.json({ id, status: 'succeeded', output: DELIVER[stage] })
}

const requestImage = (path: string) => {
  const input = fake.seen.find((r) => r.path === path)?.json?.input as { image: string; scale?: number } | undefined
  const bytes = Buffer.from((input?.image ?? '').split(',')[1] ?? '', 'base64')
  return { input, bytes, signature: bytes.subarray(1, 4).toString('latin1'), width: bytes.readUInt32BE(16) }
}

let t: TestHost
beforeAll(async () => {
  const workflows = createImageIconWorkflows(
    { registry: registry as unknown as ImageIconCaller },
    { artifacts: { root: artifacts } },
  )
  t = await startTestHost({ prefix: 'imageicon', platform: true, extra: workflows })
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
  t.json(await t.call('/workflows/image-icon', { method: 'POST', body, headers: { prefer: 'wait=60' } }))

/** What the run record carries: the steps' summed price and the steps journaled. */
async function recorded(runId: string) {
  const { rows } = await t.pool.query(`select step_id, cost from "${t.schema}".steps where run_id = $1`, [runId])
  return {
    steps: rows.map((r: { step_id: string }) => r.step_id).sort(),
    usd: rows.reduce((sum: number, r: { cost: string | null }) => sum + Number(r.cost ?? 0), 0),
  }
}

const FILE_ORDER = [
  'favicon.ico',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-mask.png',
  'apple-touch-icon.png',
  'icon-1024.png',
  'AppIcon.icns',
]
const GOLDEN_SOURCE = join(import.meta.dir, 'fixtures', 'image-icon', 'source.png')

describe('image-icon end to end', () => {
  test('a transparent 1024 master: no upscale, no cutout, vectorize runs; the set, the head tags and the price are right', async () => {
    delivers('vectorize', text(RAW_SVG), VECTORIZE)
    const { status, body } = await run({ file: GOLDEN_SOURCE })

    expect(status).toBe(200)
    expect(body).toMatchObject({ workflowId: 'image-icon', status: 'done' })
    const out = body.output
    expect(out.dir).toBe(join(artifacts, 'image-icon', body.runId))
    expect(out.workDir).toBe(join(out.dir, 'work'))
    expect(
      out.files.map((f: { name: string; mime: string; width: number; height: number }) => [
        f.name,
        f.mime,
        f.width,
        f.height,
      ]),
    ).toEqual([
      ['favicon.ico', 'image/x-icon', 48, 48],
      ['favicon.svg', 'image/svg+xml', 0, 0],
      ['icon-192.png', 'image/png', 192, 192],
      ['icon-512.png', 'image/png', 512, 512],
      ['icon-mask.png', 'image/png', 512, 512],
      ['apple-touch-icon.png', 'image/png', 180, 180],
      ['icon-1024.png', 'image/png', 1024, 1024],
      ['AppIcon.icns', 'image/icns', 1024, 1024],
    ])
    expect(out.files.map((f: { name: string }) => f.name)).toEqual(FILE_ORDER)
    for (const file of out.files) {
      expect(file.path).toBe(join(out.dir, file.name))
      expect(readFileSync(file.path).byteLength).toBe(file.bytes)
    }

    const ico = readFileSync(join(out.dir, 'favicon.ico'))
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0])
    expect(readFileSync(join(out.dir, 'AppIcon.icns')).subarray(0, 4).toString('ascii')).toBe('icns')
    for (const name of ['icon-192.png', 'icon-512.png', 'icon-mask.png', 'apple-touch-icon.png', 'icon-1024.png']) {
      const meta = await sharp(join(out.dir, name)).metadata()
      const expected = out.files.find((f: { name: string }) => f.name === name)
      expect([meta.width, meta.height]).toEqual([expected.width, expected.height])
    }

    expect(readFileSync(join(out.dir, 'favicon.svg'), 'utf8')).toBe(cleanVectorized(RAW_SVG))
    expect(out.html).toBe(iconsHtml(true))
    expect(out.html).toContain('/favicon.svg')
    expect(readFileSync(out.htmlPath, 'utf8')).toBe(`${iconsHtml(true)}\n`)
    expect(out.htmlPath).toBe(join(out.dir, 'head.html'))
    expect(out.manifest).toEqual(ICONS_MANIFEST)
    expect(out.manifestPath).toBe(join(out.dir, 'manifest.webmanifest'))
    expect(readFileSync(out.manifestPath, 'utf8')).toBe(`${JSON.stringify(ICONS_MANIFEST, null, 2)}\n`)

    expect(out.steps).toEqual([
      { step: 'vectorize', model: IMAGE_ROUTES['image.vectorize'].model, costUsd: 0.01, latencyMs: expect.any(Number) },
    ])
    expect(out.svgSkippedReason).toBeUndefined()
    expect(out.cost).toEqual({ usd: 0.01, source: 'rate' })

    // only the vectorize call went out, and it was sent the master rendered on the 1024 canvas
    expect(fake.seen.map((r) => r.path)).toEqual([VECTORIZE])
    expect(requestImage(VECTORIZE)).toMatchObject({ signature: 'PNG', width: 1024 })
    expect(existsSync(join(out.workDir, 'source.png'))).toBe(true)
    expect(existsSync(join(out.workDir, 'master.png'))).toBe(true)
    expect(existsSync(join(out.workDir, 'upscaled.png'))).toBe(false)
    expect(existsSync(join(out.workDir, 'cutout.png'))).toBe(false)

    const record = await recorded(body.runId)
    expect(record.steps).toEqual(['cutout', 'prepare', 'render', 'vectorize'])
    expect(record.usd).toBeCloseTo(0.01, 8)
  })

  test('an opaque 1024 master is cut out first: the model gets a PNG of at most 1536 px, then vectorize runs', async () => {
    delivers('cutout', await subject(1024), CUTOUT)
    delivers('vectorize', text(RAW_SVG), VECTORIZE)
    const { body } = await run({ file: await writeSource('opaque.png', await subject(1024, true)) })

    expect(body.status).toBe('done')
    expect(body.output.steps.map((s: { step: string }) => s.step)).toEqual(['cutout', 'vectorize'])
    expect(body.output.steps[0]).toMatchObject({ model: IMAGE_ROUTES['image.cutout.recraft'].model, costUsd: 0.01 })
    expect(body.output.cost).toEqual({ usd: 0.02, source: 'rate' })
    expect(fake.seen.map((r) => r.path)).toEqual([CUTOUT, VECTORIZE])
    const sent = requestImage(CUTOUT)
    expect(sent.signature).toBe('PNG')
    expect(sent.width).toBeLessThanOrEqual(1536)
    expect(existsSync(join(body.output.workDir, 'cutout-input.png'))).toBe(true)
    expect(existsSync(join(body.output.workDir, 'cutout.png'))).toBe(true)
    const record = await recorded(body.runId)
    expect(record.steps).toEqual(['cutout', 'prepare', 'render', 'vectorize'])
    expect(record.usd).toBeCloseTo(0.02, 8)
  })

  test('cutout: always cuts out a transparent master; cutout: never leaves an opaque one alone', async () => {
    delivers('cutout', await subject(1024), CUTOUT)
    const forced = await run({ file: GOLDEN_SOURCE, cutout: 'always', cutoutModel: 'recraft', svg: 'never' })
    expect(forced.body.output.steps.map((s: { step: string }) => s.step)).toEqual(['cutout'])

    fake.reset()
    const kept = await run({
      file: await writeSource('opaque2.png', await subject(1024, true)),
      cutout: 'never',
      svg: 'never',
    })
    expect(kept.body.status).toBe('done')
    expect(kept.body.output.steps).toEqual([])
    expect(fake.seen).toEqual([])
  })

  test('a 100 px master is upscaled 8x, the cutout gets the upscaled image, vectorize closes: three priced steps', async () => {
    delivers('upscale', await subject(800, true), UPSCALE)
    delivers('cutout', await subject(800), CUTOUT)
    delivers('vectorize', text(RAW_SVG), VECTORIZE)
    const { body } = await run({ file: await writeSource('small.png', await subject(100, true)) })

    expect(body.status).toBe('done')
    const out = body.output
    expect(out.steps.map((s: { step: string; costUsd: number }) => [s.step, s.costUsd])).toEqual([
      ['upscale', 0.002],
      ['cutout', 0.01],
      ['vectorize', 0.01],
    ])
    expect(out.cost).toEqual({ usd: 0.022, source: 'rate' })
    expect(fake.seen.map((r) => r.path)).toEqual([UPSCALE, CUTOUT, VECTORIZE])
    expect(requestImage(UPSCALE).input).toMatchObject({ scale: 8 })
    expect(requestImage(UPSCALE).width).toBe(100)
    // the cutout was sent the upscaled image, not the 100 px source
    expect(requestImage(CUTOUT).width).toBe(800)
    for (const name of ['source.png', 'upscaled.png', 'cutout-input.png', 'cutout.png', 'master.png']) {
      expect(existsSync(join(out.workDir, name))).toBe(true)
    }
    const record = await recorded(body.runId)
    expect(record.steps).toEqual(['cutout', 'prepare', 'render', 'upscale', 'vectorize'])
    expect(record.usd).toBeCloseTo(0.022, 8)
  })

  test('svg: never makes no vectorize call, writes no favicon.svg, and the head has no svg link', async () => {
    const { body } = await run({ file: GOLDEN_SOURCE, svg: 'never' })
    expect(body.status).toBe('done')
    const out = body.output
    expect(fake.seen).toEqual([])
    expect(out.files.map((f: { name: string }) => f.name)).toEqual(FILE_ORDER.filter((n) => n !== 'favicon.svg'))
    expect(existsSync(join(out.dir, 'favicon.svg'))).toBe(false)
    expect(out.html).toBe(iconsHtml(false))
    expect(out.html).not.toContain('favicon.svg')
    expect(readFileSync(out.htmlPath, 'utf8')).toBe(`${iconsHtml(false)}\n`)
    expect(out.steps).toEqual([])
    expect(out.svgSkippedReason).toBeUndefined()
    expect(out.cost).toEqual({ usd: 0, source: 'rate' })
    expect((await recorded(body.runId)).usd).toBe(0)
  })

  test('an SVG over 64 KB is paid for but left out: no favicon.svg, the reason is set, the head has no svg link', async () => {
    delivers('vectorize', text(BIG_SVG), VECTORIZE)
    const { body } = await run({ file: GOLDEN_SOURCE })
    expect(body.status).toBe('done')
    const out = body.output
    expect(out.files.map((f: { name: string }) => f.name)).toEqual(FILE_ORDER.filter((n) => n !== 'favicon.svg'))
    expect(existsSync(join(out.dir, 'favicon.svg'))).toBe(false)
    expect(out.svgSkippedReason).toMatch(/^vectorized SVG is \d+ KB - art with gradients\/photo detail/)
    expect(out.html).not.toContain('favicon.svg')
    expect(out.steps).toHaveLength(1)
    expect(out.cost).toEqual({ usd: 0.01, source: 'rate' })
  })

  test('invalid input fails before any billed call: relative path (400), a missing file, a non-image, upscale: always on 1500 px', async () => {
    expect((await t.call('/workflows/image-icon', { method: 'POST', body: { file: 'relative/a.png' } })).status).toBe(
      400,
    )

    const notImage = await writeSource('notes.txt', text('hello'))
    const big = await writeSource('big.png', await subject(1500, true))
    for (const [input, message] of [
      [{ file: join(root, 'missing.png') }, 'no such file'],
      [{ file: notImage }, 'image must be png, jpeg or webp'],
      [{ file: big, upscale: 'always' }, 'upscaling accepts at most 1440px'],
    ] as const) {
      const { body } = await run(input)
      expect(body.status).toBe('failed')
      expect(body.error.message).toContain('failed (invalid_input)')
      expect(body.error.message).toContain(message)
      expect((await recorded(body.runId)).usd).toBe(0)
    }
    expect(fake.seen).toEqual([])
  })

  test('a tiny opaque source whose upscale would stay under the 256 px cutout minimum fails before any billed call', async () => {
    const { body } = await run({ file: await writeSource('tiny.png', await subject(16, true)) })
    expect(body.status).toBe('failed')
    expect(body.error.message).toContain('failed (invalid_input)')
    expect(body.error.message).toContain('at least 256px')
    expect(body.error.message).toContain('128px after the upscale')
    expect(body.error.message).toContain('--cutout never')
    expect(fake.seen).toEqual([])
    expect((await recorded(body.runId)).usd).toBe(0)
  })

  test('the same tiny source with cutout: never runs: upscale 8x, render, vectorize', async () => {
    delivers('upscale', await subject(128, true), UPSCALE)
    delivers('vectorize', text(RAW_SVG), VECTORIZE)
    const { body } = await run({ file: await writeSource('tiny2.png', await subject(16, true)), cutout: 'never' })
    expect(body.status).toBe('done')
    expect(body.output.steps.map((s: { step: string }) => s.step)).toEqual(['upscale', 'vectorize'])
    expect(requestImage(UPSCALE).input).toMatchObject({ scale: 8 })
    expect(fake.seen.map((r) => r.path)).toEqual([UPSCALE, VECTORIZE])
  })

  test('a 20000x1000 source is refused when the square master would be over 8192 px, before any canvas or call', async () => {
    const wide = await png(sharp({ create: { width: 20_000, height: 1000, channels: 3, background: '#c83c28' } }))
    const { body } = await run({
      file: await writeSource('wide.png', wide),
      cutout: 'never',
      upscale: 'never',
      svg: 'never',
    })
    expect(body.status).toBe('failed')
    expect(body.error.message).toContain('failed (invalid_input)')
    expect(body.error.message).toContain('20000x1000px; the square master is at most 8192px a side')
    expect(fake.seen).toEqual([])
    expect(existsSync(join(artifacts, 'image-icon', body.runId, 'work', 'master.png'))).toBe(false)
  })

  test('a vectorized SVG with a script, a handler or a javascript: link is written clean, never as delivered', async () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><path d="M0 0h8v8z" onclick="alert(1)"/></a></svg>'
    delivers('vectorize', text(dirty), VECTORIZE)
    const { body } = await run({ file: GOLDEN_SOURCE })
    expect(body.status).toBe('done')
    const written = readFileSync(join(body.output.dir, 'favicon.svg'), 'utf8')
    expect(written).toContain('<path')
    expect(written).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i)
  })

  test('a vectorized SVG with a foreignObject fails the run and writes no favicon.svg; the vectorize price stays', async () => {
    const foreign =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>'
    delivers('vectorize', text(foreign), VECTORIZE)
    const { body } = await run({ file: GOLDEN_SOURCE })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body.error)).toContain('vectorized SVG contains active content')
    expect(existsSync(join(artifacts, 'image-icon', body.runId, 'favicon.svg'))).toBe(false)
    expect((await recorded(body.runId)).usd).toBeCloseTo(0.01, 8)
  })

  test('vectorize failing after upscale and cutout fails the run, keeps their 0.012 on the run record, and names them', async () => {
    delivers('upscale', await subject(800, true), UPSCALE)
    delivers('cutout', await subject(800), CUTOUT)
    handlers[VECTORIZE] = () => new Response('upstream broke', { status: 503 })
    const { body } = await run({ file: await writeSource('small2.png', await subject(100, true)) })

    expect(body.status).toBe('failed')
    expect(JSON.stringify(body.error)).toContain('already billed: upscale $0.002, cutout $0.01; total $0.012')
    expect(fake.seen.map((r) => r.path)).toContain(VECTORIZE)
    const record = await recorded(body.runId)
    expect(record.steps).toEqual(['cutout', 'prepare', 'render', 'upscale', 'vectorize'])
    expect(record.usd).toBeCloseTo(0.012, 8)
  })
})

describe('image-icon input', () => {
  test('the defaults, and a schema that refuses unknown keys, a bad background and a relative path', () => {
    expect(ImageIconInput.parse({ file: '/abs/a.png' })).toEqual({
      file: '/abs/a.png',
      background: '#ffffff',
      cutout: 'auto',
      cutoutModel: 'recraft',
      upscale: 'auto',
      svg: 'auto',
    })
    for (const bad of [
      { file: '/abs/a.png', extra: 1 },
      { file: '/abs/a.png', background: 'white' },
      { file: '/abs/a.png', background: '#fff' },
      { file: '/abs/a.png', background: '#12ab9fa' },
      { file: '/abs/a.png', svg: 'always' },
      { file: '/abs/a.png', cutoutModel: 'x/y' },
      { file: 'a.png' },
      {},
    ]) {
      expect(ImageIconInput.safeParse(bad).success).toBe(false)
    }
    expect(ImageIconInput.safeParse({ file: '/abs/a.png', background: '#12ab9F' }).success).toBe(true)
  })
})
