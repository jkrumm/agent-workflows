import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PlainCase, readCases } from '@agent-workflows/eval'
import type { Verdict } from '@agent-workflows/runtime'
import hygieneModule, {
  CASES_PATH,
  FIXTURE_DIR,
  FIXTURE_REF,
  hygieneSuite,
} from '../src/workflows/factory-hygiene/module.ts'
import { FactoryHygieneInput, type FactoryHygieneOutputValue } from '../src/workflows/factory-hygiene/schema.ts'
import { FactoryHygieneReference, factoryHygieneScorer } from '../src/workflows/factory-hygiene/scorer.ts'

const spot = (path: string, line: number, text: string) => ({ path, line, text })
const plants: FactoryHygieneReference['plants'] = [
  {
    kind: 'stale',
    path: 'docs/a.md',
    claim: spot('docs/a.md', 8, 'retried 3 times'),
    code: spot('src/w.js', 3, 'MAX_RETRIES = 5'),
  },
  { kind: 'slop', path: 'docs/b.md', claim: spot('docs/b.md', 5, 'cutting-edge'), quote: 'cutting-edge solution' },
]
const reference: FactoryHygieneReference = { plants, clean: ['docs/c.md'] }

type Finding = FactoryHygieneOutputValue['findings'][number]
const finding = (kind: Finding['kind'], path: string, evidence: string): Finding => ({
  kind,
  path,
  title: 'a stable title',
  evidence,
  fix: 'edit it',
})
const good = [
  finding('stale', 'docs/a.md', 'docs/a.md:8 says 3 retries; src/w.js:3 has MAX_RETRIES = 5'),
  finding('slop', 'docs/b.md', 'the line "A cutting-edge solution that empowers"'),
]
const answer = (findings: Finding[]): FactoryHygieneOutputValue => ({ findings, read: 3, reason: 'read them all' })
const score = (output: unknown, ref: FactoryHygieneReference | null = reference) =>
  factoryHygieneScorer.score({}, output as never, { reference: ref ?? undefined } as never) as Verdict

describe('factoryHygieneScorer', () => {
  test('a perfect answer scores 1 everywhere and passes', () => {
    const v = score(answer(good))
    expect(v.scores).toEqual({ valid: 1, recall: 1, anchored: 1, precision: 1, cleanKept: 1 })
    expect(v.pass).toBe(true)
    expect(v.feedback).toBeUndefined()
  })

  test('a missed plant lowers recall and is named', () => {
    const v = score(answer(good.slice(0, 1)))
    expect(v.scores).toMatchObject({ recall: 0.5, anchored: 1, precision: 1, cleanKept: 1 })
    expect(v.pass).toBe(false)
    expect(v.feedback).toContain('slop docs/b.md')
  })

  test('a finding on a clean control is a false positive', () => {
    const v = score(answer([...good, finding('slop', 'docs/c.md', 'filler')]))
    expect(v.scores).toMatchObject({ recall: 1, precision: 2 / 3, cleanKept: 0 })
    expect(v.pass).toBe(false)
    expect(v.feedback).toContain('docs/c.md')
  })

  test('a finding of the wrong kind on a plant path is no hit and no precision', () => {
    const v = score(answer([finding('slop', 'docs/a.md', 'x'), good[1] as Finding]))
    expect(v.scores).toMatchObject({ recall: 0.5, precision: 0.5 })
  })

  test('a stale finding without both path:line anchors is found but not anchored', () => {
    const noCode = finding('stale', 'docs/a.md', 'docs/a.md:8 says 3 retries')
    const far = finding('stale', 'docs/a.md', 'docs/a.md:8 says 3 retries; src/w.js:9 has MAX_RETRIES = 5')
    const bare = finding('stale', 'docs/a.md', 'the doc says 3 retries but the code has 5')
    for (const stale of [noCode, far, bare]) {
      const v = score(answer([stale, good[1] as Finding]))
      expect(v.scores).toMatchObject({ recall: 1, anchored: 0.5, precision: 1 })
      expect(v.pass).toBe(true)
    }
  })

  test('anchors accept a line within two, a range and a ./ prefix', () => {
    const near = finding('stale', 'docs/a.md', './docs/a.md:10 and src/w.js:1-2')
    expect(score(answer([near, good[1] as Finding])).scores.anchored).toBe(1)
  })

  test('a slop finding that quotes nothing planted is not anchored', () => {
    const v = score(answer([good[0] as Finding, finding('slop', 'docs/b.md', 'it is wordy')]))
    expect(v.scores).toMatchObject({ recall: 1, anchored: 0.5 })
  })

  test('no findings: recall and anchored are 0 against plants, everything else 1', () => {
    const v = score(answer([]))
    expect(v.scores).toEqual({ valid: 1, recall: 0, anchored: 0, precision: 1, cleanKept: 1 })
    expect(v.pass).toBe(false)
  })

  test('controls only: [] passes, any finding does not', () => {
    const controls: FactoryHygieneReference = { plants: [], clean: ['docs/c.md', 'docs/d.md'] }
    const none = score(answer([]), controls)
    expect(none.scores).toEqual({ valid: 1, recall: 1, anchored: 1, precision: 1, cleanKept: 1 })
    expect(none.pass).toBe(true)
    const noisy = score(answer([finding('stale', 'docs/c.md', 'x')]), controls)
    expect(noisy.scores).toMatchObject({ recall: 1, anchored: 1, precision: 0, cleanKept: 0.5 })
    expect(noisy.pass).toBe(false)
  })

  test('an invalid output scores 0 everywhere', () => {
    const v = score({ findings: 'none' })
    expect(v.scores).toEqual({ valid: 0, recall: 0, anchored: 0, precision: 0, cleanKept: 0 })
    expect(v.pass).toBe(false)
    expect(v.feedback).toContain('not a hygiene answer')
  })

  test('a failed run (null output) scores 0 and says so', () => {
    const v = score(null)
    expect(v.scores.valid).toBe(0)
    expect(v.pass).toBe(false)
    expect(v.feedback).toBe('the run failed')
  })

  test('without a reference (a drift run) only validity is scored', () => {
    expect(score(answer(good), null)).toEqual({ scores: { valid: 1 }, pass: true })
    expect(score(null, null).scores).toMatchObject({ valid: 0 })
  })
})

describe('factory-hygiene eval set', () => {
  const cases = readCases(CASES_PATH, PlainCase)
  const lineOf = (path: string, line: number) =>
    readFileSync(join(FIXTURE_DIR, path), 'utf8').split('\n')[line - 1] ?? ''

  test('three cases with unique ids', () => {
    expect(cases.map((c) => c.id)).toEqual(['all-plants-and-controls', 'controls-only', 'mixed'])
  })

  test('every case parses with the reference schema and holds no cwd', () => {
    for (const c of cases) {
      expect(FactoryHygieneReference.safeParse(c.reference).success).toBe(true)
      expect(JSON.stringify(c.input)).not.toContain('"cwd"')
    }
  })

  test('every plant sits on a real fixture line holding its text, on both sides', () => {
    for (const c of cases) {
      for (const p of FactoryHygieneReference.parse(c.reference).plants) {
        expect(p.claim.path).toBe(p.path)
        expect(lineOf(p.claim.path, p.claim.line)).toContain(p.claim.text)
        if (p.kind === 'stale') expect(lineOf(p.code.path, p.code.line)).toContain(p.code.text)
        else expect(lineOf(p.claim.path, p.claim.line).toLowerCase()).toContain(p.quote.toLowerCase())
      }
    }
  })

  test('every candidate exists in the fixture, every plant and clean path is a candidate of its kind', () => {
    for (const c of cases) {
      const ref = FactoryHygieneReference.parse(c.reference)
      const { stale, slop } = (c.input as { hygiene: { stale: { path: string }[]; slop: { path: string }[] } }).hygiene
      const staleSet = new Set(stale.map((x) => x.path))
      const slopSet = new Set(slop.map((x) => x.path))
      for (const path of [...staleSet, ...slopSet]) expect(existsSync(join(FIXTURE_DIR, path))).toBe(true)
      for (const p of ref.plants) expect((p.kind === 'stale' ? staleSet : slopSet).has(p.path)).toBe(true)
      for (const path of ref.clean) expect(staleSet.has(path) || slopSet.has(path)).toBe(true)
      for (const path of ref.clean) expect(ref.plants.some((p) => p.path === path)).toBe(false)
    }
  })

  test('the suite fills cwd and ref, and the filled input is a valid workflow input', () => {
    expect(typeof hygieneModule.suite).toBe('object')
    const read = hygieneSuite.read(CASES_PATH)
    expect(read).toHaveLength(3)
    for (const c of read) {
      expect(c.tree).toBeNull()
      const input = c.input('', {})
      const parsed = FactoryHygieneInput.parse(input)
      expect(parsed.hygiene.cwd).toBe(FIXTURE_DIR)
      expect(parsed.hygiene.ref).toBe(FIXTURE_REF)
      expect(parsed.hygiene.stale.length + parsed.hygiene.slop.length).toBeGreaterThan(0)
    }
  })
})
