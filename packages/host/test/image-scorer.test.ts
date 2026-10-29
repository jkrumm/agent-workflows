import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casesPath, PlainCase, readCases, writeCases } from '@agent-workflows/eval'
import { pngFixture } from '../../capabilities/src/image/testing.ts'
import { ImageInput, type ImageInputValue, type ImageOutputValue } from '../src/workflows/image/schema.ts'
import { imageScorer } from '../src/workflows/image/scorer.ts'

const root = mkdtempSync(join(tmpdir(), 'agw-image-scorer-'))
const dir = join(root, 'run')
const ctx = { source: 'regression' as const, signal: new AbortController().signal }

beforeAll(() => mkdirSync(dir, { recursive: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const input = (extra: Record<string, unknown>): ImageInputValue =>
  ImageInput.parse({ prompt: 'a header image', ...extra })

type Fixture = Parameters<typeof pngFixture>[2]
/** A listed file backed by a real PNG on disk, so the scorer reads what the run left. */
function made(name: string, width: number, height: number, options: Fixture = {}) {
  const bytes = pngFixture(width, height, options)
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length, width, height, hasAlpha: (options?.kind ?? 'rgba') !== 'rgb' }
}
const matte = (width: number, share: number): Fixture => ({
  alphaAt: (x) => (x < width * share ? 0 : 255),
})
const output = (files: ReturnType<typeof made>[], extra: Partial<ImageOutputValue> = {}): ImageOutputValue => ({
  kind: 'generate',
  generationId: 'g1',
  model: 'm',
  params: { model: 'm', size: '64x48', quality: 'low', n: files.length },
  size: '64x48',
  dir,
  files,
  cost: { usd: 0.01, source: 'rate' },
  latencyMs: 5,
  ...extra,
})
const score = (i: ImageInputValue, o: unknown) =>
  imageScorer.score(i, o as never, ctx) as Promise<{ scores: Record<string, number>; pass: boolean; feedback?: string }>

describe('image scorer: generation', () => {
  test('n valid PNGs at the requested size with a price pass', async () => {
    const verdict = await score(
      input({ n: 2, size: '1024x640' }),
      output([made('a1.png', 1024, 640), made('a2.png', 1024, 640)]),
    )
    expect(verdict).toEqual({ scores: { valid: 1, priced: 1 }, pass: true })
  })

  test('size auto asks nothing of the dimensions; alpha is not asked of a generation', async () => {
    const verdict = await score(input({}), output([made('b1.png', 77, 33, { kind: 'rgb' })]))
    expect(verdict).toEqual({ scores: { valid: 1, priced: 1 }, pass: true })
  })

  test('the requested size is checked after snapping, by the capability’s own snapping', async () => {
    // 1250x1250 is not a multiple of 16; the endpoint takes 1248x1248
    const snapped = await score(input({ size: '1250x1250' }), output([made('c1.png', 1248, 1248, { kind: 'rgb' })]))
    expect(snapped.scores.valid).toBe(1)
    const unsnapped = await score(input({ size: '1250x1250' }), output([made('c2.png', 1250, 1250, { kind: 'rgb' })]))
    expect(unsnapped).toMatchObject({ pass: false, scores: { valid: 0 } })
    expect(unsnapped.feedback).toContain('expected 1248x1248')
  })

  test('another count than n, or a file at the wrong size, is not valid', async () => {
    const count = await score(input({ n: 3 }), output([made('d1.png', 8, 8)]))
    expect(count).toMatchObject({ pass: false, scores: { valid: 0 } })
    expect(count.feedback).toContain('1 image(s), expected 3')
    const size = await score(
      input({ n: 2, size: '1024x640' }),
      output([made('d2.png', 1024, 640), made('d3.png', 32, 32)]),
    )
    expect(size.scores).toEqual({ valid: 0 })
    expect(size.feedback).toContain('file 2 is 32x32, expected 1024x640')
  })

  test('with --enhance the planner chose n, and the run’s own params say what that was', async () => {
    const verdict = await score(
      input({ enhance: true }),
      output([made('e1.png', 8, 8), made('e2.png', 8, 8)], { params: { model: 'm', n: 2 } }),
    )
    expect(verdict.scores.valid).toBe(1)
    expect(
      (await score(input({ enhance: true }), output([made('e3.png', 8, 8)], { params: { model: 'm', n: 2 } }))).scores
        .valid,
    ).toBe(0)
  })

  test('priced means a cost above 0 in the run: null and 0 are both unpriced', async () => {
    for (const usd of [null, 0]) {
      const verdict = await score(input({}), output([made('f1.png', 8, 8)], { cost: { usd, source: 'unknown' } }))
      expect(verdict).toMatchObject({ pass: false, scores: { valid: 1, priced: 0 } })
    }
  })
})

describe('image scorer: cutout', () => {
  const source = join(root, 'subject.png')
  beforeAll(() => writeFileSync(source, pngFixture(300, 280, { kind: 'rgb' })))
  const cut = (file: ReturnType<typeof made>) => output([file], { kind: 'cutout', params: { model: 'm', n: 1 } })
  const cutInput = () => ImageInput.parse({ file: source })

  test('input dimensions, an alpha channel with at least 5 % transparent and 5 % opaque pixels, a price: pass', async () => {
    const verdict = await score(cutInput(), cut(made('g1.png', 300, 280, matte(300, 0.4))))
    expect(verdict).toEqual({ scores: { valid: 1, alpha: 1, priced: 1 }, pass: true })
  })

  test('the thresholds are 5 % each way, on the pixels', async () => {
    expect((await score(cutInput(), cut(made('h1.png', 300, 280, matte(300, 0.05))))).scores.alpha).toBe(1)
    expect((await score(cutInput(), cut(made('h2.png', 300, 280, matte(300, 0.04))))).scores.alpha).toBe(0)
    expect((await score(cutInput(), cut(made('h3.png', 300, 280, matte(300, 0.96))))).scores.alpha).toBe(0)
  })

  test('an alpha channel that is all opaque, or all transparent, or absent, is not a cutout', async () => {
    expect((await score(cutInput(), cut(made('i1.png', 300, 280)))).scores.alpha).toBe(0)
    expect((await score(cutInput(), cut(made('i2.png', 300, 280, { alpha: 0 })))).scores.alpha).toBe(0)
    // the output claims alpha; the pixels on disk have none
    const claimed = { ...made('i3.png', 300, 280, { kind: 'rgb' }), hasAlpha: true }
    const verdict = await score(cutInput(), cut(claimed))
    expect(verdict).toMatchObject({ pass: false, scores: { valid: 1, alpha: 0 } })
    expect(verdict.feedback).toContain('5 %')
  })

  test('a model that downscaled the picture is not valid: the cutout has the input’s dimensions', async () => {
    const verdict = await score(cutInput(), cut(made('j1.png', 256, 239, matte(256, 0.4))))
    expect(verdict.scores).toEqual({ valid: 0 })
    expect(verdict.feedback).toContain('the input is 300x280')
  })

  test('a JPEG input is measured too', async () => {
    const jpeg = join(root, 'camera.jpg')
    writeFileSync(jpeg, await new Bun.Image(pngFixture(300, 280, { kind: 'rgb' })).jpeg().bytes())
    const verdict = await score(ImageInput.parse({ file: jpeg }), cut(made('k1.png', 300, 280, matte(300, 0.4))))
    expect(verdict.scores.valid).toBe(1)
  })
})

describe('image scorer: files that are not what they say', () => {
  test('missing, not a PNG, corrupt, or differing from the listing: valid 0 and nothing else', async () => {
    const good = made('l1.png', 8, 8)
    const text = join(dir, 'l2.png')
    writeFileSync(text, 'not a png, not at all, not a png, not at all')
    const corrupt = join(dir, 'l3.png')
    const bytes = pngFixture(16, 16)
    writeFileSync(corrupt, bytes.slice(0, bytes.length - 40))
    for (const files of [
      [{ ...good, path: join(dir, 'gone.png') }],
      [{ ...good, path: text }],
      [{ ...good, path: corrupt, bytes: bytes.length - 40, width: 16, height: 16 }],
      [{ ...good, width: 9 }],
      [{ ...good, bytes: good.bytes + 1 }],
      [{ ...good, path: 'relative/1.png' }],
      [],
    ]) {
      expect((await score(input({}), output(files, { params: { model: 'm', n: 1 } }))).scores).toEqual({ valid: 0 })
    }
  })

  test('a failed run (null) and an output that does not fit the schema score valid 0', async () => {
    expect(await score(input({}), null)).toMatchObject({
      pass: false,
      scores: { valid: 0 },
      feedback: 'the run failed',
    })
    expect(await score(input({}), { files: 'nope' })).toMatchObject({ pass: false, scores: { valid: 0 } })
  })
})

describe('the image eval cases', () => {
  test('the suite reads $AGW_EVAL_DIR/image/cases.jsonl as plain cases whose inputs are workflow inputs', () => {
    const env = { AGW_EVAL_DIR: join(root, 'eval') }
    const cases = [
      {
        id: 'blog-header',
        input: { prompt: 'A blog header: a lighthouse at dusk', size: '1536x1024', quality: 'low' },
        reference: null,
      },
      {
        id: 'icon-source',
        input: { prompt: 'A leaf icon', size: '1024x1024', quality: 'low', background: 'transparent' },
        reference: null,
      },
      {
        id: 'photo-edit',
        input: { prompt: 'Make it dusk', images: ['/abs/photo.png'], quality: 'low' },
        reference: null,
      },
      { id: 'cutout-1', input: { file: '/abs/generated-1.png' }, reference: null },
      { id: 'cutout-2', input: { file: '/abs/generated-2.png', model: 'bria' }, reference: null },
    ]
    writeCases(casesPath('image', env), PlainCase, cases)
    const read = readCases(casesPath('image', env), PlainCase)
    expect(read.map((c) => c.id)).toEqual(cases.map((c) => c.id))
    for (const c of read) expect(() => ImageInput.parse(c.input)).not.toThrow()
  })
})
