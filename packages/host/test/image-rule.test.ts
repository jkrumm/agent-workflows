import { describe, expect, test } from 'bun:test'
import { type ArmResult, type CaseResult, evaluateRule, paramsEqual } from '../src/workflows/image/rule.ts'
import { ImageInput, type ImageOutputValue } from '../src/workflows/image/schema.ts'

const output = (params: ImageOutputValue['params']): ImageOutputValue => ({
  kind: 'generate',
  generationId: 'g',
  model: params.model,
  params,
  dir: '/d',
  files: [],
  cost: { usd: 0.01, source: 'rate' },
  latencyMs: 1,
})
const arm = (
  over: Partial<ArmResult> = {},
  params: ImageOutputValue['params'] = { model: 'm', size: '1024x1024', quality: 'low', n: 1, returned: 1 },
): ArmResult => ({
  output: output(params),
  scores: { valid: 1, priced: 1 },
  costUsd: 0.01,
  wallMs: 1000,
  ...over,
})
const gen = (id: string, n: Partial<ArmResult> = {}, l: Partial<ArmResult> = {}): CaseResult => ({
  id,
  input: ImageInput.parse({ prompt: 'x' }),
  n: arm(n),
  l: arm(l),
})
const cutout = (id: string, nScores: Record<string, number> = { valid: 1, alpha: 1, priced: 1 }): CaseResult => ({
  id,
  input: ImageInput.parse({ file: '/abs/a.png' }),
  n: arm({ scores: nScores }, { model: 'r', n: 1, returned: 1 }),
  l: arm({}, { model: 'r', n: 1, returned: 1 }),
})
const verdictOf = (cases: CaseResult[]) => evaluateRule(cases)
const named = (cases: CaseResult[], prefix: string) => verdictOf(cases).criteria.find((c) => c.name.startsWith(prefix))

describe('the image rule', () => {
  const eight = () => [...Array.from({ length: 6 }, (_, i) => gen(`g${i}`)), cutout('c1'), cutout('c2')]

  test('eight cases that meet every criterion pass', () => {
    const verdict = verdictOf(eight())
    expect(verdict.criteria.map((c) => c.pass)).toEqual([true, true, true, true])
    expect(verdict.pass).toBe(true)
  })

  test('1: one invalid case, or one cutout without alpha, fails', () => {
    const invalid = eight()
    invalid[2] = gen('g2', { scores: { valid: 0 } })
    expect(named(invalid, '1')).toMatchObject({ pass: false })
    expect(named(invalid, '1')?.detail).toContain('g2')
    expect(named([...eight().slice(0, 7), cutout('c2', { valid: 1, alpha: 0, priced: 1 })], '1')).toMatchObject({
      pass: false,
    })
  })

  test('2: parameters compare model, size, quality and n; auto size and a side without a parameter match', () => {
    const base = { model: 'm', size: '1024x1024', quality: 'low', n: 1, returned: 1 }
    expect(paramsEqual(base, base)).toEqual([])
    expect(paramsEqual(base, { ...base, model: 'other' })).toEqual(['model m vs other'])
    expect(paramsEqual(base, { ...base, size: '1536x1024' })).toEqual(['size 1024x1024 vs 1536x1024'])
    expect(paramsEqual(base, { ...base, quality: 'high' })).toEqual(['quality low vs high'])
    expect(paramsEqual(base, { ...base, n: 2 })).toEqual(['n 1 vs 2'])
    expect(paramsEqual({ ...base, size: 'auto' }, { ...base, size: '1254x1254' })).toEqual([])
    expect(paramsEqual({ model: 'r', n: 1, returned: 1 }, { model: 'r', n: 1, returned: 1 })).toEqual([])
    const cases = eight()
    cases[0] = { ...gen('g0'), l: arm({}, { model: 'm', size: '1536x1024', quality: 'low', n: 1, returned: 1 }) }
    expect(named(cases, '2')).toMatchObject({ pass: false })
    expect(named(cases, '2')?.detail).toContain('g0: size')
  })

  test('3: N priced in every case; per case N <= 1.10 x L where both are priced', () => {
    const at = (ratio: number) => [gen('a', { costUsd: 0.01 * ratio }, { costUsd: 0.01 }), ...eight().slice(1)]
    expect(named(at(1.1), '3')).toMatchObject({ pass: true })
    expect(named(at(1.11), '3')).toMatchObject({ pass: false })
    // L unpriced: no ratio to hold; N unpriced: fails
    expect(named([gen('a', {}, { costUsd: null }), ...eight().slice(1)], '3')).toMatchObject({ pass: true })
    expect(named([gen('a', { costUsd: null }), ...eight().slice(1)], '3')).toMatchObject({ pass: false })
    expect(named([gen('a', { costUsd: 0 }), ...eight().slice(1)], '3')).toMatchObject({ pass: false })
  })

  test('4: the median wall, not the mean, at 1.25 x', () => {
    const walls = (n: number[], l: number[]) =>
      n.map((wall, i) => gen(`w${i}`, { wallMs: wall }, { wallMs: l[i] ?? 1000 }))
    // one slow outlier does not move the median
    expect(named(walls([1000, 1000, 1000, 9000, 1000], [1000, 1000, 1000, 1000, 1000]), '4')).toMatchObject({
      pass: true,
    })
    expect(named(walls([1250, 1250, 1250, 1250, 1250], [1000, 1000, 1000, 1000, 1000]), '4')).toMatchObject({
      pass: true,
    })
    expect(named(walls([1300, 1300, 1300, 1300, 1000], [1000, 1000, 1000, 1000, 1000]), '4')).toMatchObject({
      pass: false,
    })
  })

  test('an arm without output fails the parameter criterion; no cases fail', () => {
    expect(named([{ ...gen('a'), l: arm({ output: null }) }], '2')).toMatchObject({ pass: false })
    expect(verdictOf([]).pass).toBe(false)
  })
})
