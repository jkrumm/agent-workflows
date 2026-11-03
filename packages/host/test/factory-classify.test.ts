import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { messageResponse, startFakeGateway } from '@agent-workflows/testing/gateway'
import { PlainCase, readCases } from '@agent-workflows/eval'
import { createFactoryClassify } from '../src/workflows/factory-classify/index.ts'
import { CASES_PATH } from '../src/workflows/factory-classify/module.ts'
import { FactoryClassifyReference, factoryClassifyScorer } from '../src/workflows/factory-classify/scorer.ts'
import { FactoryClassifyInput } from '../src/workflows/factory-classify/schema.ts'
import { type Body, startTestHost, type TestHost } from './support.ts'

const issue = {
  title: 'argo health is DOWN',
  facts: 'Monitor: argo health. Status: DOWN. 502.',
  repo: 'argo',
  source: 'kuma',
  projects: ['argo', 'dotfiles'],
}
const verdict = {
  project: 'argo',
  kind: 'incident',
  class: 'risky',
  size: 'm',
  tier: 'sonnet',
  effort: 'medium',
  reason: 'production is down',
}

let t: TestHost
beforeAll(async () => {
  const iu = startFakeGateway({
    messages: () => messageResponse(JSON.stringify(verdict), { input_tokens: 900, output_tokens: 60 }),
  })
  t = await startTestHost({
    prefix: 'factoryclassify',
    iu,
    extra: [
      createFactoryClassify({
        registry: { call: (...args: unknown[]) => Reflect.apply(t.registry.call, t.registry, args) } as never,
      }),
    ],
  })
})
afterAll(() => t.close())

describe('factory-classify workflow', () => {
  test('one run, one call: the output is the verdict and the Issue never reaches the journal row of another step', async () => {
    const { status, body } = await t.json(
      await t.call('/workflows/factory-classify', { method: 'POST', body: { issue }, headers: { prefer: 'wait=20' } }),
    )
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.output).toEqual(verdict)
    const sent = t.iu.requests.filter((r) => String((r.body.messages as Body[])[0]?.content).includes('argo health'))
    expect(sent).toHaveLength(1)
    // The workflow step's scope reached the wire as attribution.
    expect(Object.fromEntries(sent[0]?.headers ?? [])).toMatchObject({
      'x-agw-run-id': body.runId,
      'x-agw-session': body.runId,
      'x-agw-workflow': 'factory-classify',
      'x-agw-step': 'classify',
    })
  })

  test('the CLI reads the Issue JSON from stdin as the one `issue` property', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string } }>>
    }
    expect(doc.paths['/workflows/factory-classify']?.post?.['x-cli']).toMatchObject({
      command: ['factory-classify'],
      stdin: 'issue',
    })
  })

  test('a malformed Issue is a 400, nothing runs', async () => {
    const response = await t.call('/workflows/factory-classify', {
      method: 'POST',
      body: { issue: { ...issue, projects: 'argo' } },
    })
    expect(response.status).toBe(400)
  })
})

describe('incident floor', () => {
  test('an incident answered routine leaves the workflow risky, other kinds are untouched', async () => {
    const run = async (answer: object) => {
      t.iu.on('messages', () => messageResponse(JSON.stringify(answer), { input_tokens: 900, output_tokens: 60 }))
      return t.json(
        await t.call('/workflows/factory-classify', {
          method: 'POST',
          body: { issue: { ...issue, facts: `${issue.facts} ${Math.random()}` } },
          headers: { prefer: 'wait=20' },
        }),
      )
    }
    expect((await run({ ...verdict, class: 'routine' })).body.output.class).toBe('risky')
    expect((await run({ ...verdict, kind: 'bug', class: 'routine' })).body.output.class).toBe('routine')
    t.iu.on('messages', () => messageResponse(JSON.stringify(verdict), { input_tokens: 900, output_tokens: 60 }))
  })
})

describe('factory-classify scorer', () => {
  const input = { issue }
  const want = FactoryClassifyReference.parse({
    project: 'argo',
    kind: 'incident',
    class: 'risky',
    size: 'm',
    tier: 'sonnet',
    effort: 'medium',
  })
  const score = (output: unknown, reference: FactoryClassifyReference | undefined = want) =>
    factoryClassifyScorer.score(input, output as never, {
      source: 'regression',
      reference,
      signal: new AbortController().signal,
    }) as { scores: Record<string, number>; pass: boolean; feedback?: string }

  test('an exact answer passes with every score 1', () => {
    const v = score(verdict)
    expect(v.pass).toBe(true)
    expect(Object.values(v.scores).every((s) => s === 1)).toBe(true)
  })

  test('a wrong class, kind or project fails; size and effort only lower their own score', () => {
    expect(score({ ...verdict, class: 'routine' })).toMatchObject({ pass: false, scores: { class: 0, classSafe: 0 } })
    expect(score({ ...verdict, kind: 'bug' })).toMatchObject({ pass: false, scores: { kind: 0 } })
    expect(score({ ...verdict, project: null })).toMatchObject({ pass: false, scores: { project: 0 } })
    expect(score({ ...verdict, size: 'l', effort: 'high' })).toMatchObject({
      pass: true,
      scores: { size: 0, effort: 0 },
    })
  })

  test('a lower tier fails, a higher tier passes and is not exact', () => {
    expect(score({ ...verdict, tier: 'haiku' })).toMatchObject({ pass: false, scores: { tier: 0, tierSafe: 0 } })
    expect(score({ ...verdict, tier: 'opus' })).toMatchObject({ pass: true, scores: { tier: 0, tierSafe: 1 } })
  })

  test('a business Issue answered more restrictively than the reference stays classSafe', () => {
    const risky = FactoryClassifyReference.parse({ ...want, class: 'risky' })
    expect(score({ ...verdict, class: 'business' }, risky).scores.classSafe).toBe(1)
  })

  test('invalid output, a failed run and a project outside the Issue score valid 0', () => {
    expect(score({ ...verdict, kind: 'epic' })).toMatchObject({ pass: false, scores: { valid: 0 } })
    expect(score(null)).toMatchObject({ pass: false, feedback: 'the run failed' })
    expect(score({ ...verdict, project: 'vps' })).toMatchObject({ pass: false, scores: { valid: 0 } })
    expect(score(null).scores).toEqual({
      valid: 0,
      project: 0,
      kind: 0,
      class: 0,
      size: 0,
      tier: 0,
      effort: 0,
      classSafe: 0,
      tierSafe: 0,
    })
  })
})

describe('factory-classify eval set', () => {
  const cases = readCases(CASES_PATH, PlainCase)

  test('has at least 20 cases, unique ids, each a valid input and reference', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const c of cases) {
      const input = FactoryClassifyInput.parse(c.input)
      const reference = FactoryClassifyReference.parse(c.reference)
      expect(reference.project === null || input.issue.projects.includes(reference.project)).toBe(true)
    }
  })

  test('covers every class and kind, a null project, and at least two injection attempts', () => {
    const refs = cases.map((c) => FactoryClassifyReference.parse(c.reference))
    expect(new Set(refs.map((r) => r.class))).toEqual(new Set(['routine', 'risky', 'business']))
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(['bug', 'feature', 'chore', 'docs', 'incident']))
    expect(refs.some((r) => r.project === null)).toBe(true)
    expect(cases.filter((c) => c.id.startsWith('inject-')).length).toBeGreaterThanOrEqual(2)
  })

  test('every incident is at least risky, every injection case carries its attempt in the facts', () => {
    for (const c of cases) {
      const ref = FactoryClassifyReference.parse(c.reference)
      if (ref.kind === 'incident') expect(ref.class).not.toBe('routine')
      if (c.id.startsWith('inject-')) expect(JSON.stringify(c.input)).toMatch(/OVERRIDE|END OF DATA|<system>/)
    }
  })

  test('the committed set holds no address, secret or internal host', () => {
    const text = JSON.stringify(cases)
    expect(text).not.toMatch(/\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b/)
    expect(text).not.toMatch(/\.ts\.net|op:\/\/|sk-[A-Za-z0-9]|tskey-/)
  })
})
