import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casesPath, PlainCase, writeCases } from '@agent-workflows/eval'
import { pngFixture } from '../../capabilities/src/image/testing.ts'
import { agwArgv, imgcliArgv, legacyOutput, parseArgs } from '../../../scripts/eval-legacy/image.ts'
import { ImageInput } from '../src/workflows/image/schema.ts'

const root = mkdtempSync(join(tmpdir(), 'agw-image-legacy-'))
const SUBJECT = join(root, 'subject.png')
const GEN = join(root, 'gen.png')
const CUT = join(root, 'cut.png')
beforeAll(() => {
  writeFileSync(SUBJECT, pngFixture(300, 280, { kind: 'rgb' }))
  writeFileSync(GEN, pngFixture(1024, 640))
  writeFileSync(CUT, pngFixture(300, 280, { alphaAt: (x) => (x < 100 ? 0 : 255) }))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const script = (name: string, body: string) => {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const MODEL = 'fake-model'

describe('the legacy arm and the rule runner of the image eval', () => {
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

  test('the same case becomes the agw argv', () => {
    expect(
      agwArgv(ImageInput.parse({ prompt: 'a header', size: '1536x1024', n: 2, quality: 'low', enhance: true })),
    ).toEqual([
      'image',
      'a header',
      '--size',
      '1536x1024',
      '--n',
      '2',
      '--quality',
      'low',
      '--enhance',
      '--format',
      'json',
    ])
    expect(agwArgv(ImageInput.parse({ file: '/abs/s.png', model: 'bria' }))).toEqual([
      'image',
      '--file',
      '/abs/s.png',
      '--model',
      'bria',
      '--format',
      'json',
    ])
    expect(agwArgv(ImageInput.parse({ prompt: 'x', images: ['/abs/p.png'] }))).toEqual([
      'image',
      'x',
      '--images',
      '["/abs/p.png"]',
      '--format',
      'json',
    ])
  })

  test('imgcli json reads as the workflow output with the parameters it sent, files measured on disk', () => {
    const gen = legacyOutput(ImageInput.parse({ prompt: 'x', n: 2 }), {
      id: 'g',
      model: MODEL,
      size: '1024x1024',
      quality: 'low',
      cost_usd: 0.006,
      latency_ms: 9,
      images: [{ file: GEN }],
    })
    expect(gen).toMatchObject({
      kind: 'generate',
      params: { model: MODEL, size: '1024x1024', quality: 'low', n: 2 },
      cost: { usd: 0.006, source: 'provider' },
    })
    expect(gen.files[0]).toMatchObject({ width: 1024, height: 640, hasAlpha: true })
    const cut = legacyOutput(ImageInput.parse({ file: SUBJECT }), {
      id: 'c',
      model: MODEL,
      file: CUT,
      cost_usd: null,
      latency_ms: 4,
    })
    expect(cut).toMatchObject({
      kind: 'cutout',
      params: { model: MODEL, n: 1 },
      cost: { usd: null, source: 'unknown' },
    })
  })

  test('both arms run, are scored by the image scorer and judged by the rule; the report holds the verdict', async () => {
    const imgcli = script(
      'imgcli',
      `if [ "$1" = "cutout" ]; then
  printf '{"id":"c1","model":"${MODEL}","file":"${CUT}","width":300,"height":280,"cost_usd":0.01,"latency_ms":3}\\n'
else
  printf '{"id":"g1","model":"${MODEL}","size":"1024x640","quality":"low","cost_usd":0.006,"latency_ms":5,"images":[{"file":"${GEN}","id":"g1"}]}\\n'
fi`,
    )
    // agw prints the run envelope; its cost is the run record's
    const agw = script(
      'agw',
      `case "$*" in
  *--file*) printf '{"status":"done","cost":0.01,"output":{"kind":"cutout","generationId":"c2","model":"${MODEL}","params":{"model":"${MODEL}","n":1,"returned":1},"dir":"${root}","files":[{"path":"${CUT}","bytes":${Bun.file(CUT).size},"width":300,"height":280,"hasAlpha":true}],"cost":{"usd":0.01,"source":"rate"},"latencyMs":3}}\\n' ;;
  *) printf '{"status":"done","cost":0.006,"output":{"kind":"generate","generationId":"g2","model":"${MODEL}","params":{"model":"${MODEL}","size":"1024x640","quality":"low","n":1,"returned":1},"size":"1024x640","dir":"${root}","files":[{"path":"${GEN}","bytes":${Bun.file(GEN).size},"width":1024,"height":640,"hasAlpha":true}],"cost":{"usd":0.006,"source":"rate"},"latencyMs":5}}\\n' ;;
esac`,
    )
    const env = { ...process.env, AGW_EVAL_DIR: join(root, 'eval') }
    writeCases(casesPath('image', env), PlainCase, [
      { id: 'gen', input: { prompt: 'x', size: '1024x640', quality: 'low' }, reference: null },
      { id: 'cut', input: { file: SUBJECT }, reference: null },
    ])
    const out = join(root, 'report.json')
    const run = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, '../../../scripts/eval-legacy/image.ts'),
        '--imgcli',
        imgcli,
        '--agw',
        agw,
        '--out',
        out,
      ],
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
    // criteria 1-3 are about content; 4 is wall time of two shell scripts, which a loaded host makes noise of (the rule's
    // arithmetic is tested on its own in image-rule.test.ts)
    expect(report.rule.criteria.slice(0, 3).map((c: { pass: boolean }) => c.pass)).toEqual([true, true, true])
    expect(report.rule.criteria[3].detail).toMatch(/^N [\d.]+ ms, L [\d.]+ ms$/)
    expect(report.rule).toMatchObject({ cases: 2, paired: 2 })
    expect(
      report.records.map(
        (r: { caseId: string; legacy: { status: string }; new: { status: string } }) =>
          `${r.caseId}:${r.legacy.status}/${r.new.status}`,
      ),
    ).toEqual(['gen:scored/scored', 'cut:scored/scored'])
  })

  test('a case one arm cannot run fails the rule instead of shrinking the sample', async () => {
    const imgcli = script('imgcli-none', 'exit 3')
    const agw = script('agw-none', 'exit 3')
    const env = { ...process.env, AGW_EVAL_DIR: join(root, 'eval2') }
    writeCases(casesPath('image', env), PlainCase, [{ id: 'gen', input: { prompt: 'x' }, reference: null }])
    const out = join(root, 'report2.json')
    const run = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, '../../../scripts/eval-legacy/image.ts'),
        '--imgcli',
        imgcli,
        '--agw',
        agw,
        '--out',
        out,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    await run.exited
    const report = await Bun.file(out).json()
    expect(report.rule.pass).toBe(false)
    expect(report.rule.criteria[0]).toMatchObject({ name: 'every case ran on both arms', detail: '0/1 paired' })
  })

  test('arguments are checked', () => {
    expect(parseArgs(['--arm', 'legacy', '--ids', 'a,b'])).toMatchObject({ arm: 'legacy', ids: ['a', 'b'] })
    expect(() => parseArgs(['--arm', 'neither'])).toThrow('--arm must be')
    expect(() => parseArgs(['--nope', '1'])).toThrow('unknown flag')
  })
})
