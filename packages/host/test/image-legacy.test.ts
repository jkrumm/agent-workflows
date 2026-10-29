import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casesPath, PlainCase, writeCases } from '@agent-workflows/eval'
import { pngFixture } from '../../capabilities/src/image/testing.ts'
import { imgcliArgv, legacyOutput, parseArgs, summarize } from '../../../scripts/eval-legacy/image.ts'
import { ImageInput } from '../src/workflows/image/schema.ts'

const root = mkdtempSync(join(tmpdir(), 'agw-image-legacy-'))
beforeAll(() => {
  writeFileSync(join(root, 'gen.png'), pngFixture(64, 48))
  writeFileSync(join(root, 'cut.png'), pngFixture(300, 280, { kind: 'palette' }))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the legacy arm of the image eval', () => {
  test('a case becomes the imgcli argv it would have been typed as', () => {
    const gen = ImageInput.parse({
      prompt: 'a header',
      size: '1536x1024',
      n: 2,
      quality: 'low',
      background: 'transparent',
    })
    expect(imgcliArgv(gen, '/t/out.png')).toEqual({
      argv: [
        'gen',
        'a header',
        '--n',
        '2',
        '--json',
        '--size',
        '1536x1024',
        '--quality',
        'low',
        '--background',
        'transparent',
      ],
    })
    expect(imgcliArgv(ImageInput.parse({ prompt: 'dusk', images: ['/abs/p.png'] }), '/t/out.png')).toEqual({
      argv: ['gen', 'dusk', '--n', '1', '--json', '--edit', '/abs/p.png'],
    })
    expect(imgcliArgv(ImageInput.parse({ file: '/abs/s.png', model: 'bria' }), '/t/out.png')).toEqual({
      argv: ['cutout', '/abs/s.png', '--model', 'bria', '--out', '/t/out.png', '--json'],
    })
    expect(imgcliArgv(ImageInput.parse({ prompt: 'x', images: ['/a.png', '/b.png'] }), '/t/o.png')).toEqual({
      skip: 'imgcli edits one image',
    })
  })

  test('imgcli json reads as the workflow output, files measured on disk', () => {
    const gen = legacyOutput(ImageInput.parse({ prompt: 'x' }), {
      id: 'g',
      model: 'flare',
      size: '1024x1024',
      cost_usd: 0.006,
      latency_ms: 9,
      images: [{ file: join(root, 'gen.png') }],
    })
    expect(gen).toMatchObject({
      kind: 'generate',
      generationId: 'g',
      size: '1024x1024',
      cost: { usd: 0.006, source: 'provider' },
    })
    expect(gen.files[0]).toMatchObject({ width: 64, height: 48, hasAlpha: true })
    const cut = legacyOutput(ImageInput.parse({ file: '/abs/s.png' }), {
      id: 'c',
      model: 'recraft',
      file: join(root, 'cut.png'),
      cost_usd: null,
      latency_ms: 4,
    })
    expect(cut).toMatchObject({ kind: 'cutout', cost: { usd: null, source: 'unknown' } })
    expect(cut.files[0]).toMatchObject({ width: 300, height: 280, hasAlpha: true })
  })

  test('the runner drives the binary it is given, scores with the image scorer and writes the report', async () => {
    const bin = join(root, 'imgcli')
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "cutout" ]; then
  printf '{"id":"c1","model":"recraft","file":"%s","width":300,"height":280,"cost_usd":0.01,"latency_ms":3}\\n' "${join(root, 'cut.png')}"
else
  printf '{"id":"g1","model":"flare","size":"64x48","quality":"low","cost_usd":0.006,"latency_ms":5,"images":[{"file":"%s","id":"g1"}]}\\n' "${join(root, 'gen.png')}"
fi
`,
    )
    chmodSync(bin, 0o755)
    const env = { ...process.env, AGW_EVAL_DIR: join(root, 'eval') }
    writeCases(casesPath('image', env), PlainCase, [
      { id: 'gen', input: { prompt: 'x', size: '64x48' }, reference: null },
      { id: 'cut', input: { file: '/abs/s.png' }, reference: null },
      { id: 'multi', input: { prompt: 'x', images: ['/a.png', '/b.png'] }, reference: null },
    ])
    const out = join(root, 'report.json')
    const run = Bun.spawn(
      ['bun', join(import.meta.dir, '../../../scripts/eval-legacy/image.ts'), '--imgcli', bin, '--out', out],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout).out).toBe(out)
    const report = await Bun.file(out).json()
    expect(report.summary).toMatchObject({ runs: 3, scored: 2, skipped: 1, failed: 0, passRate: 1, costUsd: 0.016 })
    expect(report.records.map((r: { caseId: string; status: string }) => `${r.caseId}:${r.status}`)).toEqual([
      'gen:scored',
      'cut:scored',
      'multi:skipped',
    ])
  })

  test('arguments are checked', () => {
    expect(parseArgs(['--runs', '3', '--ids', 'a,b'])).toMatchObject({ runs: 3, ids: ['a', 'b'] })
    expect(() => parseArgs(['--runs', '0'])).toThrow('positive integer')
    expect(() => parseArgs(['--nope', '1'])).toThrow('unknown flag')
    expect(summarize([])).toMatchObject({ runs: 0, passRate: null })
  })
})
