import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Json, WorkflowError } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'
import { compactView, keptElements, parseExisting } from '../src/workflows/diagram/document.ts'
import type { Hydrate } from '../src/workflows/diagram/hydrate.ts'
import { createDiagramWorkflows } from '../src/workflows/diagram/index.ts'
import { parseDocument } from '../src/workflows/diagram/metrics.ts'
import { diagramTask } from '../src/workflows/diagram/prompts.ts'
import { DiagramInput, DiagramOutput, MAX_EXISTING_BYTES } from '../src/workflows/diagram/schema.ts'
import { parseEnvelope, prepareSkeleton } from '../src/workflows/diagram/skeleton.ts'

const db = freshSchema('diagram')

const box = (id: string, x: number, y: number, label?: string) => ({
  type: 'rectangle',
  id,
  x,
  y,
  width: 180,
  height: 70,
  ...(label ? { label: { text: label, fontSize: 18 } } : {}),
})
const arrow = (id: string, from: string, to: string) => ({
  type: 'arrow',
  id,
  x: 0,
  y: 0,
  width: 1,
  height: 0,
  points: [
    [0, 0],
    [1, 0],
  ],
  endArrowhead: 'arrow',
  start: { id: from },
  end: { id: to },
})
const camera = { type: 'cameraUpdate', x: 0, y: 0, width: 800, height: 600 }
const envelope = (elements: unknown[], rationale = 'Left to right.') => JSON.stringify({ rationale, elements })
const BRIEF = 'Flow: a request enters the server, is queued, then handled by a worker.'

const [diagram] = createDiagramWorkflows(undefined, { agentBackoffMs: 10 })

async function run(
  input: Record<string, Json>,
  host: FakeAgentHost,
  options?: Parameters<typeof createDiagramWorkflows>[1],
) {
  const [entry] = options ? createDiagramWorkflows(undefined, { agentBackoffMs: 10, ...options }) : [diagram]
  const wf = entry?.workflow as NonNullable<typeof entry>['workflow']
  const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
  await rt.open()
  try {
    const { runId } = await rt.start(wf, input, { purpose: 'build' })
    return await rt.wait(runId)
  } finally {
    await rt.close()
  }
}

/** The finished run's output, parsed; fails the test with the run's error when it did not finish. */
function outputOf(result: Awaited<ReturnType<typeof run>>) {
  if (result.status !== 'done') throw new Error(`run ${result.status}: ${result.error?.kind}: ${result.error?.message}`)
  return DiagramOutput.parse(result.output)
}

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(() => db.drop())

describe('diagram workflow, real hydration', () => {
  test('the fake agent skeleton comes back as an openable v2 document with fitted labels', async () => {
    const host = new FakeAgentHost(async () => ({
      output: envelope([
        camera,
        box('server', 60, 100, 'HTTP server'),
        box('queue', 340, 100, 'job queue'),
        box('worker', 620, 100, 'worker session'),
        arrow('a1', 'server', 'queue'),
        arrow('a2', 'queue', 'worker'),
        { type: 'text', id: 'note', x: 340, y: 220, text: 'sqlite store', fontSize: 16 },
      ]),
    }))
    const output = outputOf(await run({ brief: BRIEF }, host))
    expect(output.rationale).toBe('Left to right.')
    expect(output.viewport).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    const file = parseDocument(output.document)
    expect(file).not.toBeNull()
    expect(file).toMatchObject({ type: 'excalidraw', version: 2 })
    // 3 boxes + 2 arrows + 1 note + 3 box labels; the camera pseudo-element is not drawn
    expect(output.elementCount).toBe(9)
    expect(file?.elements.some((e) => e.type === 'cameraUpdate')).toBe(false)
    const a1 = file?.elements.find((e) => e.id === 'a1')
    expect(a1?.startBinding?.elementId).toBe('server')
    expect(a1?.endBinding?.elementId).toBe('queue')
    // The label is measured with the app's own font: "HTTP server" at 18 px is about 100 px wide, not a guess and not x10
    const label = file?.elements.find((e) => e.type === 'text' && e.containerId === 'server')
    expect(label?.width).toBeGreaterThan(60)
    expect(label?.width).toBeLessThan(160)
    expect(host.count('followUp')).toBe(0)
  }, 30_000)

  test('extend with restoreCheckpoint keeps the existing elements, deletes by id and binds a new arrow to an old box', async () => {
    const create = new FakeAgentHost(async () => ({
      output: envelope([
        box('a', 60, 100, 'first'),
        box('b', 340, 100, 'second'),
        box('c', 620, 100, 'third'),
        arrow('ab', 'a', 'b'),
      ]),
    }))
    const created = outputOf(await run({ brief: BRIEF }, create))

    const extend = new FakeAgentHost(async (s) => {
      // the existing diagram is in the request, in skeleton vocabulary
      expect(s.spec.prompt).toContain('"id":"a"')
      expect(s.spec.prompt).toContain('"label":{"text":"second"}')
      expect(s.spec.prompt).not.toContain('"seed"')
      return {
        output: envelope([
          { type: 'restoreCheckpoint' },
          { type: 'delete', ids: 'c' },
          box('d', 340, 300, 'fourth'),
          arrow('bd', 'b', 'd'),
        ]),
      }
    })
    const extended = outputOf(
      await run({ brief: 'Add a fourth box below the second', mode: 'extend', existing: created.document }, extend),
    )
    const file = parseDocument(extended.document)
    const ids = new Set(file?.elements.map((e) => e.id))
    expect(ids.has('a') && ids.has('b') && ids.has('d')).toBe(true)
    expect(ids.has('c')).toBe(false)
    // the old arrow keeps its bindings, the new one binds to the old box, and the old box lists both
    expect(file?.elements.find((e) => e.id === 'ab')?.endBinding?.elementId).toBe('b')
    expect(file?.elements.find((e) => e.id === 'bd')?.startBinding?.elementId).toBe('b')
    const bound = (file?.elements.find((e) => e.id === 'b')?.boundElements ?? []) as { id: string }[]
    const listed = bound.map((e) => e.id)
    expect(listed).toEqual(expect.arrayContaining(['ab', 'bd']))
    // 'c' and its label are gone, 'first'/'second' labels survive
    const texts = file?.elements.filter((e) => e.type === 'text').map((e) => e.text)
    expect(texts).toEqual(expect.arrayContaining(['first', 'second', 'fourth']))
    expect(texts).not.toContain('third')
  }, 60_000)
})

describe('extend, kept elements', () => {
  const file = (elements: object[]) => {
    const parsed = parseExisting(JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {} }))
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.file
  }
  const shape = (id: string, extra: object = {}) => ({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra,
  })

  test('deleting a box drops its label, its arrows and the labels of those arrows, transitively', () => {
    const doc = file([
      shape('r'),
      shape('other'),
      shape('rl', { type: 'text', containerId: 'r' }),
      shape('a', { type: 'arrow', startBinding: { elementId: 'r' }, endBinding: { elementId: 'other' } }),
      shape('al', { type: 'text', containerId: 'a' }),
      shape('b', { type: 'arrow', startBinding: { elementId: 'other' }, endBinding: { elementId: 'other' } }),
      shape('bl', { type: 'text', containerId: 'b' }),
    ])
    expect(keptElements(doc, ['r']).map((e) => e.id)).toEqual(['other', 'b', 'bl'])
    expect(keptElements(doc, []).map((e) => e.id)).toHaveLength(7)
  })

  test('a deleted id may be drawn again, in the skeleton checks and in a real extend', async () => {
    const known = new Set(['b'])
    expect(
      prepareSkeleton([{ type: 'restoreCheckpoint' }, { type: 'delete', ids: 'b' }, box('b', 0, 0)], known).ok,
    ).toBe(true)
    const created = outputOf(
      await run(
        { brief: BRIEF },
        new FakeAgentHost(async () => ({
          output: envelope([box('a', 60, 100, 'first'), box('b', 340, 100, 'old'), arrow('ab', 'a', 'b')]),
        })),
      ),
    )
    const redraw = new FakeAgentHost(async () => ({
      output: envelope([
        { type: 'restoreCheckpoint' },
        { type: 'delete', ids: 'b' },
        box('b', 340, 300, 'new'),
        arrow('ab2', 'a', 'b'),
      ]),
    }))
    const file2 = parseDocument(
      outputOf(await run({ brief: BRIEF, mode: 'extend', existing: created.document }, redraw)).document,
    )
    expect(file2?.elements.filter((e) => e.id === 'b')).toHaveLength(1)
    expect(file2?.elements.find((e) => e.id === 'b')?.y).toBe(300)
    expect(file2?.elements.find((e) => e.id === 'ab')).toBeUndefined()
    expect(file2?.elements.find((e) => e.id === 'ab2')?.endBinding?.elementId).toBe('b')
    const texts = file2?.elements.filter((e) => e.type === 'text').map((e) => e.text)
    expect(texts).toEqual(expect.arrayContaining(['first', 'new']))
    expect(texts).not.toContain('old')
    expect(redraw.count('followUp')).toBe(0)
  }, 30_000)
})

describe('diagram extend, real hydration', () => {
  test('deleting a box prunes the entries of its label and arrows from the survivors', async () => {
    const created = outputOf(
      await run(
        { brief: BRIEF },
        new FakeAgentHost(async () => ({
          output: envelope([box('a', 60, 100, 'first'), box('b', 340, 100, 'second'), arrow('ab', 'a', 'b')]),
        })),
      ),
    )
    const extend = new FakeAgentHost(async () => ({
      output: envelope([{ type: 'restoreCheckpoint' }, { type: 'delete', ids: 'b' }, box('c', 340, 300, 'third')]),
    }))
    const file = parseDocument(
      outputOf(await run({ brief: BRIEF, mode: 'extend', existing: created.document }, extend)).document,
    )
    const ids = new Set(file?.elements.map((e) => e.id))
    expect([...ids].some((id) => id === 'b' || id === 'ab')).toBe(false)
    for (const element of file?.elements ?? [])
      for (const ref of (element.boundElements ?? []) as { id: string }[]) expect(ids.has(ref.id)).toBe(true)
    // 'a' lost the arrow it was bound to, and keeps its own label
    const a = file?.elements.find((e) => e.id === 'a')
    expect((a?.boundElements ?? []) as unknown[]).toHaveLength(1)
  }, 30_000)

  test('a new element reusing an existing id is re-asked, with the error text', async () => {
    const created = outputOf(
      await run({ brief: BRIEF }, new FakeAgentHost(async () => ({ output: envelope([box('a', 60, 100, 'first')]) }))),
    )
    const extend = new FakeAgentHost(async (s) => {
      if (!s.turnOf) return { output: envelope([{ type: 'restoreCheckpoint' }, box('a', 300, 100, 'again')]) }
      expect(s.sent).toContain('rectangle "a": the id exists in the existing diagram, use a new id')
      return { output: envelope([{ type: 'restoreCheckpoint' }, box('b', 300, 100, 'again')]) }
    })
    const output = outputOf(await run({ brief: BRIEF, mode: 'extend', existing: created.document }, extend))
    expect(output.elementCount).toBe(4)
    expect(extend.count('followUp')).toBe(1)
  }, 30_000)
})

describe('diagram workflow, fake hydration', () => {
  const identity: Hydrate = async (skeleton) => ({
    ok: true,
    file: {
      type: 'excalidraw',
      version: 2,
      source: 'test',
      elements: skeleton.map((e) => ({ x: 0, y: 0, width: 1, height: 1, ...(e as object) })) as never,
      appState: {},
      files: {},
    },
  })

  test('an invalid answer is re-asked once in the same session with the errors, then accepted', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.turnOf) return { output: envelope([box('a', 0, 0, 'one'), arrow('x', 'a', 'ghost')]) }
      expect(s.sent).toContain('end.id "ghost" matches no element')
      return { output: envelope([box('a', 0, 0, 'one'), box('b', 300, 0, 'two'), arrow('x', 'a', 'b')]) }
    })
    const output = outputOf(await run({ brief: BRIEF }, host, { hydrate: identity }))
    expect(output.elementCount).toBe(3)
    expect(host.count('followUp')).toBe(1)
    expect(host.count('open')).toBe(1)
  })

  test('a second invalid answer fails the run as invalid_output', async () => {
    const host = new FakeAgentHost(async () => ({ output: 'I drew a lovely diagram, see above.' }))
    const result = await run({ brief: BRIEF }, host, { hydrate: identity })
    expect(result.status).toBe('failed')
    expect(result.error?.kind).toBe('invalid_output')
    expect(result.error?.message).toContain('rejected twice')
    expect(host.count('followUp')).toBe(1)
  })

  test('a skeleton the library cannot convert is re-asked with the library error', async () => {
    let calls = 0
    const flaky: Hydrate = async (skeleton, signal) =>
      ++calls === 1 ? { ok: false, error: 'boom' } : identity(skeleton, signal)
    const host = new FakeAgentHost(async (s) => {
      if (s.turnOf) expect(s.sent).toContain('could not be converted: boom')
      return { output: envelope([box('a', 0, 0)]) }
    })
    expect(outputOf(await run({ brief: BRIEF }, host, { hydrate: flaky })).elementCount).toBe(1)
    expect(calls).toBe(2)
  })

  test('a hydration timeout fails the run once: no step retry and no re-ask', async () => {
    let calls = 0
    const hangs: Hydrate = async () => {
      calls++
      throw new WorkflowError('timeout', 'hydration timed out after 30000 ms')
    }
    const host = new FakeAgentHost(async () => ({ output: envelope([box('a', 0, 0)]) }))
    const result = await run({ brief: BRIEF }, host, { hydrate: hangs })
    expect(result.status).toBe('failed')
    expect(calls).toBe(1)
    expect(host.count('followUp')).toBe(0)
    expect(result.error?.kind).toBe('step_failed')
    expect(result.error?.message).toContain('timeout')
  })

  test('the legacy bare array is accepted as the elements', async () => {
    const host = new FakeAgentHost(async () => ({ output: JSON.stringify([camera, box('a', 0, 0, 'x')]) }))
    const output = outputOf(await run({ brief: BRIEF }, host, { hydrate: identity }))
    expect(output.rationale).toBe('')
    expect(output.viewport?.width).toBe(800)
  })

  test('extend needs a document, create takes none', () => {
    expect(DiagramInput.safeParse({ brief: BRIEF, mode: 'extend' }).success).toBe(false)
    expect(DiagramInput.safeParse({ brief: BRIEF, existing: '{}' }).success).toBe(false)
    expect(DiagramInput.safeParse({ brief: BRIEF, mode: 'extend', existing: '{}' }).success).toBe(true)
    expect(DiagramInput.parse({ brief: BRIEF }).mode).toBe('create')
  })

  test('an existing document that is not a v2 .excalidraw file is invalid_input before any agent runs', async () => {
    const host = new FakeAgentHost()
    const result = await run({ brief: BRIEF, mode: 'extend', existing: '{"type":"nope"}' }, host, { hydrate: identity })
    expect(result.status).toBe('failed')
    expect(result.error?.kind).toBe('invalid_input')
    expect(host.count('open')).toBe(0)
  })
})

describe('skeleton checks and prefilter', () => {
  test('pseudo-elements become the viewport, the deleted ids and the restore flag, and are never drawn', () => {
    const checked = prepareSkeleton(
      [
        { type: 'restoreCheckpoint' },
        { type: 'delete', ids: 'b2, a1,t3' },
        { type: 'cameraUpdate', x: 5, y: 6, width: 400, height: 300 },
        box('n', 0, 0),
      ],
      new Set(['b2', 'a1', 't3']),
    )
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.prepared).toMatchObject({
      restore: true,
      deletedIds: ['b2', 'a1', 't3'],
      viewport: { x: 5, y: 6, width: 400, height: 300 },
    })
    expect(checked.prepared.drawn.map((e) => e.id)).toEqual(['n'])
  })

  test('computed fields are dropped from the agent’s elements', () => {
    const checked = prepareSkeleton([{ ...box('a', 0, 0), seed: 1, version: 3, boundElements: [], groupIds: ['g'] }])
    expect(checked.ok && checked.prepared.drawn[0]).toEqual(box('a', 0, 0))
  })

  test('problems are listed for the re-ask', () => {
    const checked = prepareSkeleton([
      box('a', 0, 0),
      box('a', 10, 10),
      { type: 'rectangle', id: 'r', x: 0 },
      { type: 'blob', id: 'z' },
      { type: 'text', id: 't', x: 0, y: 0 },
      arrow('x', 'a', 'nowhere'),
      { type: 'cameraUpdate', x: 0 },
    ])
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    const all = checked.errors.join('\n')
    for (const part of [
      'duplicate id "a"',
      'needs numeric x and y',
      'unknown type "blob"',
      'text needs a non-empty text',
      'matches no element',
      'cameraUpdate needs',
    ])
      expect(all).toContain(part)
  })

  test('an arrow may bind to an existing id only after restoreCheckpoint', () => {
    const known = new Set(['old'])
    expect(prepareSkeleton([box('n', 0, 0), arrow('x', 'n', 'old')], known).ok).toBe(false)
    expect(prepareSkeleton([{ type: 'restoreCheckpoint' }, box('n', 0, 0), arrow('x', 'n', 'old')], known).ok).toBe(
      true,
    )
    expect(
      prepareSkeleton(
        [{ type: 'restoreCheckpoint' }, { type: 'delete', ids: 'old' }, box('n', 0, 0), arrow('x', 'n', 'old')],
        known,
      ).ok,
    ).toBe(false)
  })

  test('extend rules: restoreCheckpoint needs extend mode, delete needs restoreCheckpoint and existing ids, new ids must be new', () => {
    const errorsOf = (elements: object[], known?: Set<string>) => {
      const checked = prepareSkeleton(elements as never, known)
      return checked.ok ? [] : checked.errors
    }
    const known = new Set(['old', 'other'])
    expect(errorsOf([{ type: 'restoreCheckpoint' }, box('n', 0, 0)])).toEqual([
      'restoreCheckpoint needs extend mode: there is no existing diagram to keep',
    ])
    expect(errorsOf([{ type: 'delete', ids: 'old' }, box('n', 0, 0)], known)).toEqual([
      'delete acts on the existing diagram: begin with restoreCheckpoint',
    ])
    expect(
      errorsOf([{ type: 'restoreCheckpoint' }, { type: 'delete', ids: 'old,ghost' }, box('n', 0, 0)], known),
    ).toEqual(['delete: "ghost" is not an id of the existing diagram'])
    expect(errorsOf([{ type: 'restoreCheckpoint' }, box('old', 0, 0)], known)).toEqual([
      'rectangle "old": the id exists in the existing diagram, use a new id',
    ])
    // a replacement (no restoreCheckpoint) may use any id: it replaces the diagram
    expect(errorsOf([box('old', 0, 0)], known)).toEqual([])
  })

  test('envelope parsing tolerates a code fence and reports a non-JSON answer', () => {
    expect(parseEnvelope(`\`\`\`json\n${envelope([box('a', 0, 0)])}\n\`\`\``).ok).toBe(true)
    expect(parseEnvelope('nope')).toEqual({ ok: false, errors: ['the answer is not JSON'] })
    expect(parseEnvelope('{"rationale":"x","elements":[]}').ok).toBe(false)
  })

  test('the existing diagram reaches the agent compactly, with labels folded in and bindings as start/end', () => {
    const file = parseExisting(
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [
          { id: 'r', type: 'rectangle', x: 1, y: 2, width: 3, height: 4, seed: 99, boundElements: [] },
          { id: 't', type: 'text', x: 1, y: 2, width: 3, height: 4, text: 'hi', containerId: 'r' },
          {
            id: 'a',
            type: 'arrow',
            x: 0,
            y: 0,
            width: 5,
            height: 0,
            startBinding: { elementId: 'r' },
            endBinding: { elementId: 'r' },
          },
          { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
        ],
        appState: {},
      }),
    )
    expect(file.ok).toBe(true)
    if (!file.ok) return
    const lines = compactView(file.file).split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toEqual({
      id: 'r',
      type: 'rectangle',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      label: { text: 'hi' },
    })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ id: 'a', start: { id: 'r' }, end: { id: 'r' } })
  })

  test('existing has a size cap, and embedded files never reach the prompt', () => {
    const big = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], pad: 'x'.repeat(MAX_EXISTING_BYTES) })
    const capped = DiagramInput.safeParse({ brief: BRIEF, mode: 'extend', existing: big })
    expect(capped.success).toBe(false)
    expect(JSON.stringify(capped.error?.issues)).toContain('512 KB')
    expect(DiagramInput.safeParse({ brief: BRIEF, mode: 'extend', existing: '{"type":"excalidraw"}' }).success).toBe(
      true,
    )
    const file = parseExisting(
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [{ id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'f1' }],
        appState: {},
        files: { f1: { dataURL: 'data:image/png;base64,SECRETPIXELS' } },
      }),
    )
    expect(file.ok).toBe(true)
    if (file.ok) expect(compactView(file.file)).not.toContain('SECRETPIXELS')
  })

  test('the existing diagram is fenced as data and the request is stable', () => {
    const a = diagramTask({ brief: BRIEF, mode: 'extend' }, '{"id":"x"}')
    expect(a).toContain('<<<EXISTING-DIAGRAM')
    expect(a).toBe(diagramTask({ brief: BRIEF, mode: 'extend' }, '{"id":"x"}'))
    expect(diagramTask({ brief: BRIEF, mode: 'create' })).not.toContain('Existing diagram')
  })
})
