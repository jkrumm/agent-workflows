import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import sharp from 'sharp'
import { EVAL_DIR, imageIconSuite } from '../src/workflows/image-icon/module.ts'
import imageIconModule from '../src/workflows/image-icon/module.ts'
import { encode, FIXTURES, pixels } from '../src/workflows/image-icon/eval/generate.ts'
import {
  buildMaster,
  decodeRgba,
  ICONS_MANIFEST,
  iconsHtml,
  renderRasters,
} from '../src/workflows/image-icon/pipeline.ts'
import { ImageIconInput, type ImageIconOutputValue } from '../src/workflows/image-icon/schema.ts'
import { ImageIconReference, imageIconScorer } from '../src/workflows/image-icon/scorer.ts'

const root = mkdtempSync(join(tmpdir(), 'agw-icon-scorer-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const fixture = (name: string) => {
  const found = FIXTURES.find((f) => f.name === name)
  if (!found) throw new Error(name)
  return found
}

type Made = { output: ImageIconOutputValue; dir: string }
let counter = 0

/** A real icon set from a fixture, written to disk the way the workflow writes it. */
async function makeSet(options: {
  source: string
  background?: string
  svg?: 'made' | 'skipped' | 'never'
  steps?: ('upscale' | 'cutout' | 'vectorize')[]
}): Promise<Made> {
  const { source, background = '#ffffff', svg = 'never', steps = [] } = options
  const dir = join(root, `set-${counter++}`)
  mkdirSync(dir, { recursive: true })
  const master = await buildMaster(await decodeRgba(await encode(fixture(source))))
  const assets = await renderRasters(master, background)
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>')
  const files = assets.map((a) => ({ name: a.name, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes }))
  if (svg === 'made')
    files.splice(1, 0, { name: 'favicon.svg', mime: 'image/svg+xml', width: 0, height: 0, bytes: svgBytes })
  for (const f of files) await Bun.write(join(dir, f.name), f.bytes)
  const html = iconsHtml(svg === 'made')
  await Bun.write(join(dir, 'head.html'), `${html}\n`)
  await Bun.write(join(dir, 'manifest.webmanifest'), `${JSON.stringify(ICONS_MANIFEST, null, 2)}\n`)
  const output: ImageIconOutputValue = {
    dir,
    workDir: join(dir, 'work'),
    files: files.map((f) => ({ ...f, path: join(dir, f.name), bytes: f.bytes.byteLength })),
    html,
    htmlPath: join(dir, 'head.html'),
    manifest: ICONS_MANIFEST,
    manifestPath: join(dir, 'manifest.webmanifest'),
    steps: steps.map((step) => ({ step, model: 'm', costUsd: 0.01, latencyMs: 5 })),
    ...(svg === 'skipped' ? { svgSkippedReason: 'vectorized SVG is 70 KB' } : {}),
    cost: { usd: Number((steps.length * 0.01).toFixed(6)), source: 'rate' },
    latencyMs: 10,
  }
  return { output, dir }
}

const score = (input: object, output: unknown, reference?: ImageIconReference) =>
  imageIconScorer.score(ImageIconInput.parse({ file: '/x.png', ...input }), output as never, {
    source: 'regression',
    signal: new AbortController().signal,
    ...(reference ? { reference } : {}),
  })

const ALL = ['valid', 'files', 'dimensions', 'manifest', 'svg', 'background', 'cost']
const WITH_REFERENCE = [...ALL, 'steps', 'alpha']

describe('image-icon scorer', () => {
  test('a perfect set with a cutout, an upscale and an svg passes every score', async () => {
    const { output } = await makeSet({
      source: 'disc-transparent-512.png',
      svg: 'made',
      steps: ['upscale', 'cutout', 'vectorize'],
    })
    const verdict = await score({}, output, { steps: ['upscale', 'cutout', 'vectorize'], transparentCorner: true })
    expect(verdict.feedback).toBeUndefined()
    expect(verdict.pass).toBe(true)
    expect(Object.keys(verdict.scores).sort()).toEqual([...WITH_REFERENCE].sort())
    expect(Object.values(verdict.scores).every((v) => v === 1)).toBe(true)
  })

  test('without a reference (drift) it scores the output on its own and leaves steps and alpha out', async () => {
    const { output } = await makeSet({ source: 'disc-opaque-512.png' })
    const verdict = await score({ svg: 'never' }, output)
    expect(verdict.pass).toBe(true)
    expect(Object.keys(verdict.scores).sort()).toEqual([...ALL].sort())
  })

  test('a skipped svg is consistent with a reason and no file; both or neither is not', async () => {
    const skipped = await makeSet({ source: 'disc-transparent-512.png', svg: 'skipped', steps: ['vectorize'] })
    expect((await score({}, skipped.output)).scores.svg).toBe(1)
    const both = await makeSet({ source: 'disc-transparent-512.png', svg: 'made', steps: ['vectorize'] })
    const bothVerdict = await score({}, { ...both.output, svgSkippedReason: 'too big' })
    expect(bothVerdict.scores.svg).toBe(0)
    const neither = await makeSet({ source: 'disc-transparent-512.png', svg: 'never', steps: ['vectorize'] })
    expect((await score({}, neither.output)).scores.svg).toBe(0)
  })

  test('svg never with an svg, a reason or a vectorize step is a miss', async () => {
    const withFile = await makeSet({ source: 'disc-transparent-512.png', svg: 'made', steps: ['vectorize'] })
    expect((await score({ svg: 'never' }, withFile.output)).scores.svg).toBe(0)
    const withReason = await makeSet({ source: 'disc-transparent-512.png', svg: 'never' })
    expect((await score({ svg: 'never' }, { ...withReason.output, svgSkippedReason: 'x' })).scores.svg).toBe(0)
  })

  test('a missing file fails files, and the verdict names it; the rest of the set still scores', async () => {
    const { output, dir } = await makeSet({ source: 'disc-opaque-512.png' })
    rmSync(join(dir, 'icon-192.png'))
    const verdict = await score({ svg: 'never' }, output)
    expect(verdict.pass).toBe(false)
    expect(verdict.scores.files).toBe(0)
    expect(verdict.scores.manifest).toBe(1)
    expect(verdict.feedback).toContain('icon-192.png is not on disk')
  })

  test('a listing missing a file, or out of order, fails files', async () => {
    const { output } = await makeSet({ source: 'disc-opaque-512.png' })
    const short = { ...output, files: output.files.filter((f) => f.name !== 'AppIcon.icns') }
    expect((await score({ svg: 'never' }, short)).scores.files).toBe(0)
    const swapped = { ...output, files: [...output.files].reverse() }
    expect((await score({ svg: 'never' }, swapped)).scores.files).toBe(0)
  })

  test('a PNG of the wrong size on disk fails dimensions even when the listing says right', async () => {
    const { output, dir } = await makeSet({ source: 'disc-opaque-512.png' })
    await Bun.write(
      join(dir, 'icon-512.png'),
      await sharp(pixels(fixture('disc-opaque-64.png')), { raw: { width: 64, height: 64, channels: 4 } })
        .png()
        .toBuffer(),
    )
    const verdict = await score({ svg: 'never' }, output)
    expect(verdict.scores.dimensions).toBe(0)
    expect(verdict.feedback).toContain('icon-512.png is 64x64 on disk')
  })

  test('a listing with the wrong size fails dimensions', async () => {
    const { output } = await makeSet({ source: 'disc-opaque-512.png' })
    const wrong = {
      ...output,
      files: output.files.map((f) => (f.name === 'apple-touch-icon.png' ? { ...f, width: 192, height: 192 } : f)),
    }
    expect((await score({ svg: 'never' }, wrong)).scores.dimensions).toBe(0)
  })

  test('a manifest pointing at a file that is not in the set fails manifest', async () => {
    const { output } = await makeSet({ source: 'disc-opaque-512.png' })
    const icons = output.manifest.icons.map((i) => (i.src === '/icon-512.png' ? { ...i, src: '/icon-999.png' } : i))
    const verdict = await score({ svg: 'never' }, { ...output, manifest: { icons } })
    expect(verdict.scores.manifest).toBe(0)
    expect(verdict.feedback).toContain('/icon-999.png is not a listed file')
  })

  test('an svg link without favicon.svg fails manifest', async () => {
    const { output } = await makeSet({ source: 'disc-opaque-512.png' })
    expect((await score({ svg: 'never' }, { ...output, html: iconsHtml(true) })).scores.manifest).toBe(0)
  })

  test('the background must be the input colour on apple-touch-icon', async () => {
    const { output } = await makeSet({ source: 'disc-transparent-512.png', background: '#0b1020' })
    expect((await score({ svg: 'never', background: '#0b1020' }, output)).scores.background).toBe(1)
    expect((await score({ svg: 'never', background: '#ff0000' }, output)).scores.background).toBe(0)
  })

  test('steps and cost: a different step list, an unknown price or a wrong sum is a miss', async () => {
    const { output } = await makeSet({ source: 'disc-transparent-512.png', svg: 'made', steps: ['vectorize'] })
    const reference = { steps: ['upscale' as const, 'vectorize' as const], transparentCorner: true }
    expect((await score({}, output, reference)).scores.steps).toBe(0)
    const unknown = {
      ...output,
      steps: [{ ...output.steps[0], costUsd: null }],
      cost: { usd: null, source: 'unknown' as const },
    }
    expect((await score({}, unknown)).scores.cost).toBe(0)
    expect((await score({}, { ...output, cost: { usd: 0.5, source: 'rate' } })).scores.cost).toBe(0)
  })

  test('alpha: an opaque ground kept where the cutout was expected fails, a cutout where it was not expected fails', async () => {
    const kept = await makeSet({ source: 'disc-opaque-512.png' })
    const asCutout = await score({ svg: 'never' }, kept.output, { steps: [], transparentCorner: true })
    expect(asCutout.scores.alpha).toBe(0)
    expect((await score({ svg: 'never' }, kept.output, { steps: [], transparentCorner: false })).scores.alpha).toBe(1)
    const cut = await makeSet({ source: 'disc-transparent-512.png' })
    expect((await score({ svg: 'never' }, cut.output, { steps: [], transparentCorner: false })).scores.alpha).toBe(0)
  })

  test('a failed run or an output that is not an icon set scores zero everywhere', async () => {
    const reference = { steps: [], transparentCorner: true }
    for (const output of [null, {}, { files: 'x' }]) {
      const verdict = await score({}, output, reference)
      expect(verdict.pass).toBe(false)
      expect(Object.keys(verdict.scores).sort()).toEqual([...WITH_REFERENCE].sort())
      expect(Object.values(verdict.scores).every((v) => v === 0)).toBe(true)
    }
    expect((await score({}, null, reference)).feedback).toBe('the run failed')
  })
})

describe('image-icon eval suite', () => {
  const cases = imageIconSuite.read(imageIconSuite.path?.({}) ?? '')

  test('six cases; every input fits the workflow on an absolute file that exists; every reference fits the scorer', () => {
    expect(cases.map((c) => c.id)).toEqual(['icon-01', 'icon-02', 'icon-03', 'icon-04', 'icon-05', 'icon-06'])
    for (const c of cases) {
      const input = ImageIconInput.parse(c.input('/unused', {}))
      expect(isAbsolute(input.file)).toBe(true)
      expect(existsSync(input.file)).toBe(true)
      expect(() => ImageIconReference.parse(c.reference)).not.toThrow()
      expect(c.tree).toBeNull()
    }
  })

  test('an arm argument wins over the recorded input, the file included', () => {
    const first = cases[0]
    expect(first?.input('/unused', { upscale: 'never' }).upscale).toBe('never')
    expect(first?.input('/unused', { file: '/other.png' }).file).toBe('/other.png')
  })

  test('the references follow the inputs: no model step without a reason, a vectorize step exactly when svg is auto', () => {
    for (const c of cases) {
      const input = ImageIconInput.parse(c.input('/unused', {}))
      const reference = ImageIconReference.parse(c.reference)
      expect(reference.steps.includes('vectorize')).toBe(input.svg === 'auto')
      if (input.cutout === 'never') expect(reference.steps).not.toContain('cutout')
      if (input.upscale === 'never') expect(reference.steps).not.toContain('upscale')
    }
  })

  test('the module declares it', () => {
    expect(imageIconModule.id).toBe('image-icon')
    expect(imageIconModule.suite).toBe(imageIconSuite)
  })

  test('the committed fixtures are what the generator draws', async () => {
    for (const f of FIXTURES) {
      const decoded = await decodeRgba(await Bun.file(join(EVAL_DIR, f.name)).bytes())
      expect(decoded.width).toBe(f.size)
      expect(decoded.data.equals(pixels(f))).toBe(true)
    }
  })
})
