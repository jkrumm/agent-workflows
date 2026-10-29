import { describe, expect, test } from 'bun:test'
import {
  boundArrowShare,
  countOverlaps,
  countTextOverflow,
  measureDocument,
  parseDocument,
} from '../src/workflows/diagram/metrics.ts'
import type { DocElement } from '../src/workflows/diagram/schema.ts'
import { diagramScorer } from '../src/workflows/diagram/scorer.ts'

const el = (
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
) => ({ id, type, x, y, width, height, ...extra }) as DocElement
const doc = (elements: DocElement[]) =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 't', elements, appState: {}, files: {} })
const ctx = { source: 'regression' as const, signal: new AbortController().signal }
const input = { brief: 'x'.repeat(12), mode: 'create' as const }
const output = (document: string) => ({ document, elementCount: 1, viewport: null, rationale: '' })

describe('diagram metrics on handcrafted documents', () => {
  test('a clean diagram: bound arrows, no overlap, labels fit', () => {
    const elements = [
      el('a', 'rectangle', 0, 0, 100, 60, { boundElements: [{ id: 'ar', type: 'arrow' }] }),
      el('b', 'rectangle', 200, 0, 100, 60),
      el('ar', 'arrow', 100, 30, 100, 0, { startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } }),
      el('t', 'text', 10, 20, 80, 20, { containerId: 'a', text: 'ok' }),
    ]
    expect(measureDocument(doc(elements))).toEqual({
      valid: true,
      elementCount: 4,
      boundArrowShare: 1,
      overlaps: 0,
      textOverflow: 0,
    })
  })

  test('an unbound arrow, a half-bound arrow and a dangling binding lower the share', () => {
    const base = [el('a', 'rectangle', 0, 0, 10, 10), el('b', 'rectangle', 50, 0, 10, 10)]
    const bound = el('ok', 'arrow', 10, 5, 40, 0, { startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } })
    expect(boundArrowShare([...base, bound])).toBe(1)
    expect(
      boundArrowShare([...base, bound, el('free', 'arrow', 0, 20, 40, 0, { startBinding: null, endBinding: null })]),
    ).toBe(0.5)
    expect(
      boundArrowShare([
        ...base,
        el('half', 'arrow', 0, 0, 5, 0, { startBinding: { elementId: 'a' }, endBinding: null }),
      ]),
    ).toBe(0)
    expect(
      boundArrowShare([
        ...base,
        el('dangling', 'arrow', 0, 0, 5, 0, { startBinding: { elementId: 'a' }, endBinding: { elementId: 'zzz' } }),
      ]),
    ).toBe(0)
    expect(boundArrowShare(base)).toBeNull()
  })

  test('crossing shapes overlap; a zone holding its nodes, touching edges and bound labels do not', () => {
    expect(countOverlaps([el('a', 'rectangle', 0, 0, 100, 100), el('b', 'ellipse', 60, 60, 100, 100)])).toBe(1)
    const zone = [
      el('z', 'rectangle', 0, 0, 400, 300),
      el('n1', 'rectangle', 20, 40, 100, 60),
      el('n2', 'diamond', 200, 40, 100, 60),
    ]
    expect(countOverlaps(zone)).toBe(0)
    expect(countOverlaps([el('a', 'rectangle', 0, 0, 100, 100), el('b', 'rectangle', 100, 0, 100, 100)])).toBe(0)
    expect(
      countOverlaps([el('a', 'rectangle', 0, 0, 100, 100), el('t', 'text', 10, 10, 50, 20, { containerId: 'a' })]),
    ).toBe(0)
    // a node poking out of its zone is an overlap; three mutually crossing shapes are three pairs
    expect(countOverlaps([...zone, el('out', 'rectangle', 350, 250, 100, 100)])).toBe(1)
    expect(
      countOverlaps([
        el('a', 'rectangle', 0, 0, 100, 100),
        el('b', 'rectangle', 50, 50, 100, 100),
        el('c', 'rectangle', 25, 25, 100, 100),
      ]),
    ).toBe(3)
  })

  test('a label wider than its container overflows; arrow labels and deleted elements do not count', () => {
    const container = el('c', 'rectangle', 0, 0, 100, 60)
    expect(countTextOverflow([container, el('t', 'text', 0, 0, 140, 20, { containerId: 'c' })])).toBe(1)
    expect(countTextOverflow([container, el('t', 'text', 0, 0, 99, 20, { containerId: 'c' })])).toBe(0)
    expect(
      countTextOverflow([el('ar', 'arrow', 0, 0, 5, 0), el('t', 'text', 0, 0, 80, 20, { containerId: 'ar' })]),
    ).toBe(0)
    expect(countTextOverflow([container, el('t', 'text', 0, 0, 140, 20, { containerId: 'c', isDeleted: true })])).toBe(
      0,
    )
  })

  test('only a v2 envelope with elements and appState is valid', () => {
    const one = [el('a', 'rectangle', 0, 0, 1, 1)]
    expect(parseDocument(doc(one))).not.toBeNull()
    expect(parseDocument('not json')).toBeNull()
    expect(parseDocument(JSON.stringify({ type: 'excalidraw', version: 1, elements: one, appState: {} }))).toBeNull()
    expect(parseDocument(JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {} }))).toBeNull()
    expect(parseDocument(JSON.stringify({ type: 'excalidraw', version: 2, elements: one }))).toBeNull()
    expect(
      parseDocument(JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'a' }], appState: {} })),
    ).toBeNull()
  })
})

describe('diagram scorer', () => {
  const clean = doc([
    el('a', 'rectangle', 0, 0, 100, 60),
    el('b', 'rectangle', 200, 0, 100, 60),
    el('ar', 'arrow', 100, 30, 100, 0, { startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } }),
  ])

  test('a clean document passes with every score', async () => {
    const verdict = await diagramScorer.score(input, output(clean), ctx)
    expect(verdict).toEqual({
      pass: true,
      scores: { valid: 1, elementCount: 3, overlaps: 0, textOverflow: 0, boundArrowShare: 1 },
    })
  })

  test('a diagram without arrows leaves the bound share out', async () => {
    const verdict = await diagramScorer.score(input, output(doc([el('a', 'rectangle', 0, 0, 1, 1)])), ctx)
    expect(verdict.scores.boundArrowShare).toBeUndefined()
    expect(verdict.pass).toBe(true)
  })

  test('an unbound arrow and an overflowing label fail the run with feedback; overlaps are reported', async () => {
    const bad = doc([
      el('a', 'rectangle', 0, 0, 100, 60),
      el('b', 'rectangle', 50, 20, 100, 60),
      el('free', 'arrow', 0, 100, 50, 0),
      el('t', 'text', 0, 0, 130, 20, { containerId: 'a' }),
    ])
    const verdict = await diagramScorer.score(input, output(bad), ctx)
    expect(verdict.pass).toBe(false)
    expect(verdict.scores).toMatchObject({ valid: 1, boundArrowShare: 0, overlaps: 1, textOverflow: 1 })
    expect(verdict.feedback).toContain('not bound')
    expect(verdict.feedback).toContain('wider than their container')
  })

  test('an invalid run scores only valid=0: no overlaps, overflow or count to pull a mean down', async () => {
    expect((await diagramScorer.score(input, output('nope'), ctx)).scores).toEqual({ valid: 0 })
    const failed = await diagramScorer.score(input, null, ctx)
    expect(failed).toMatchObject({ pass: false, scores: { valid: 0 }, feedback: 'the run failed' })
  })

  test('a reference bounds the element count', async () => {
    const ranged = { ...ctx, reference: { minElements: 5 } }
    const verdict = await diagramScorer.score(input, output(clean), ranged)
    expect(verdict.scores.inRange).toBe(0)
    expect(verdict.pass).toBe(false)
    expect(
      (await diagramScorer.score(input, output(clean), { ...ctx, reference: { minElements: 3, maxElements: 4 } }))
        .scores.inRange,
    ).toBe(1)
  })
})
