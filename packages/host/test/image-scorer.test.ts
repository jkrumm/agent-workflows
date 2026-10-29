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
const cutoutInput = (): ImageInputValue => ImageInput.parse({ file: '/abs/subject.png' })

/** A listed file backed by a real PNG on disk, so the scorer reads what the run left. */
function made(name: string, width: number, height: number, kind: 'rgba' | 'rgb' | 'palette' = 'rgba') {
  const bytes = pngFixture(width, height, { kind })
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length, width, height, hasAlpha: kind !== 'rgb' }
}
const output = (files: ReturnType<typeof made>[], extra: Partial<ImageOutputValue> = {}): ImageOutputValue => ({
  kind: 'generate',
  generationId: 'g1',
  model: 'm',
  size: '64x48',
  dir,
  files,
  cost: { usd: 0.01, source: 'rate' },
  latencyMs: 5,
  ...extra,
})
const score = (i: ImageInputValue, o: unknown) =>
  imageScorer.score(i, o as never, ctx) as { scores: Record<string, number>; pass: boolean; feedback?: string }

describe('image scorer', () => {
  test('a generation that made the images asked for, at the size asked for, with a price, passes', () => {
    const verdict = score(input({ n: 2, size: '64x48' }), output([made('a1.png', 64, 48), made('a2.png', 64, 48)]))
    expect(verdict).toEqual({ scores: { valid: 1, count: 1, size: 1, cost: 1 }, pass: true })
  })

  test('size auto asks nothing of the dimensions; no alpha is asked of an opaque generation', () => {
    const verdict = score(input({}), output([made('b1.png', 77, 33, 'rgb')]))
    expect(verdict.scores).toEqual({ valid: 1, count: 1, cost: 1 })
    expect(verdict.pass).toBe(true)
  })

  test('a size that was snapped is compared with the size the run reports it requested', () => {
    const snapped = output([made('c1.png', 48, 48)], { size: '48x48', snappedFrom: '50x50' })
    expect(score(input({ size: '50x50' }), snapped).scores.size).toBe(1)
    // a report that does not follow from the input scores 0 even when the files match it
    expect(score(input({ size: '64x64' }), snapped).scores.size).toBe(0)
    const silent = output([made('c2.png', 48, 48)], { size: '48x48' })
    expect(score(input({ size: '50x50' }), silent)).toMatchObject({ pass: false, scores: { size: 0 } })
  })

  test('the share of files at the requested size is the score', () => {
    const verdict = score(input({ n: 2, size: '64x48' }), output([made('d1.png', 64, 48), made('d2.png', 32, 32)]))
    expect(verdict.scores.size).toBe(0.5)
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toContain('not every image is 64x48')
  })

  test('n images asked, another count made', () => {
    const verdict = score(input({ n: 3 }), output([made('e1.png', 8, 8)]))
    expect(verdict).toMatchObject({ pass: false, scores: { valid: 1, count: 0 } })
    expect(verdict.feedback).toContain('1 image(s), asked for 3')
  })

  test('a cutout is one image and must carry an alpha channel', () => {
    const good = output([made('f1.png', 300, 280, 'palette')], { kind: 'cutout' })
    expect(score(cutoutInput(), good)).toEqual({ scores: { valid: 1, count: 1, alpha: 1, cost: 1 }, pass: true })
    const opaque = output([{ ...made('f2.png', 300, 280, 'rgb'), hasAlpha: true }], { kind: 'cutout' })
    // the output claims alpha; the file on disk has none
    expect(score(cutoutInput(), opaque)).toMatchObject({ pass: false, scores: { alpha: 0 } })
  })

  test('a generation with a transparent background is held to alpha too', () => {
    const verdict = score(input({ background: 'transparent' }), output([made('g1.png', 8, 8, 'rgb')]))
    expect(verdict.scores.alpha).toBe(0)
    expect(verdict.pass).toBe(false)
  })

  test('a run that recorded no price fails the cost score', () => {
    const verdict = score(input({}), output([made('h1.png', 8, 8)], { cost: { usd: null, source: 'unknown' } }))
    expect(verdict).toMatchObject({ pass: false, scores: { cost: 0 } })
  })

  test('valid is the only score when a listed file is missing, not a PNG, or differs from what the output lists', () => {
    const good = made('i1.png', 8, 8)
    const text = join(dir, 'i2.png')
    writeFileSync(text, 'not a png, not at all, not a png, not at all')
    for (const files of [
      [{ ...good, path: join(dir, 'gone.png') }],
      [{ ...good, path: text }],
      [{ ...good, width: 9 }],
      [{ ...good, bytes: good.bytes + 1 }],
      [{ ...good, path: 'relative/1.png' }],
      [],
    ]) {
      expect(score(input({}), output(files)).scores).toEqual({ valid: 0 })
    }
  })

  test('a failed run (null) and an output that does not fit the schema score valid 0', () => {
    expect(score(input({}), null)).toMatchObject({ pass: false, scores: { valid: 0 }, feedback: 'the run failed' })
    expect(score(input({}), { files: 'nope' })).toMatchObject({ pass: false, scores: { valid: 0 } })
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
