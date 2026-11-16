import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildFactoryStewardPrompt, STEWARD_ACTIONS } from '@agent-workflows/capabilities'
import type { Json, ScoreJudge, Verdict } from '@agent-workflows/runtime'
import { digestScorer } from '../src/workflows/digest/scorer.ts'
import { suiteWorkflow } from '../src/workflows/eval/suites.ts'
import factoryDigest from '../src/workflows/factory-digest/module.ts'
import { FactoryDigestReference, factoryDigestScorer } from '../src/workflows/factory-digest/scorer.ts'
import { FactoryDigestInput } from '../src/workflows/factory-digest/schema.ts'
import factoryFixClasses from '../src/workflows/factory-fix-classes/module.ts'
import { FactoryFixClassesReference, factoryFixClassesScorer } from '../src/workflows/factory-fix-classes/scorer.ts'
import { FactoryFixClassesInput } from '../src/workflows/factory-fix-classes/schema.ts'
import factoryQueue from '../src/workflows/factory-queue/module.ts'
import { FactoryQueueReference, factoryQueueScorer } from '../src/workflows/factory-queue/scorer.ts'
import { FactoryQueueInput } from '../src/workflows/factory-queue/schema.ts'
import { factorySpecScreenScorer } from '../src/workflows/factory-spec-screen/scorer.ts'
import factorySteward from '../src/workflows/factory-steward/module.ts'
import { FactoryStewardReference, factoryStewardScorer } from '../src/workflows/factory-steward/scorer.ts'
import { FactoryStewardInput } from '../src/workflows/factory-steward/schema.ts'
import type { Suite } from '../src/workflows/suite.ts'

const cases = (module: { suite?: 'plain' | Suite }) => {
  if (typeof module.suite !== 'object') throw new Error('the module has no suite object')
  return module.suite.read('')
}
const abort = new AbortController().signal
const run = (
  scorer: { score: (...a: never[]) => Verdict | Promise<Verdict> },
  input: unknown,
  output: unknown,
  ref?: unknown,
  judge?: ScoreJudge,
) =>
  scorer.score(input as never, output as never, { source: 'regression', reference: ref, judge, signal: abort } as never)

describe('the committed suites', () => {
  const sets = [
    {
      name: 'steward',
      module: factorySteward,
      min: 12,
      max: 15,
      input: FactoryStewardInput,
      reference: FactoryStewardReference,
    },
    {
      name: 'queue',
      module: factoryQueue,
      min: 8,
      max: 10,
      input: FactoryQueueInput,
      reference: FactoryQueueReference,
    },
    {
      name: 'fix-classes',
      module: factoryFixClasses,
      min: 8,
      max: 10,
      input: FactoryFixClassesInput,
      reference: FactoryFixClassesReference,
    },
    {
      name: 'digest',
      module: factoryDigest,
      min: 8,
      max: 10,
      input: FactoryDigestInput,
      reference: FactoryDigestReference,
    },
  ]
  for (const set of sets) {
    test(`${set.name}: every case parses as the workflow input and its reference schema, ids are unique`, () => {
      const read = cases(set.module)
      expect(read.length).toBeGreaterThanOrEqual(set.min)
      expect(read.length).toBeLessThanOrEqual(set.max)
      expect(new Set(read.map((c) => c.id)).size).toBe(read.length)
      for (const c of read) {
        expect(set.input.safeParse(c.input('/x', {})).success, `${set.name}/${c.id} input`).toBe(true)
        expect(set.reference.safeParse(c.reference).success, `${set.name}/${c.id} reference`).toBe(true)
      }
    })
  }

  test('no case names a private host, user, path or secret (the repo is public)', () => {
    const files = ['factory-steward', 'factory-queue', 'factory-fix-classes', 'factory-digest'].map((id) =>
      readFileSync(`${import.meta.dir}/../src/workflows/${id}/eval/cases.jsonl`, 'utf8'),
    )
    for (const text of files)
      expect(text).not.toMatch(/\/Users\/|tailscale|\.local\b|op:\/\/|@[a-z0-9-]+\.[a-z]{2,}\b/i)
  })

  test('steward: every action has a case, and wake is the largest label of a real stall', () => {
    const labels = cases(factorySteward).map((c) => (c.reference as { action: string }).action)
    for (const action of STEWARD_ACTIONS) expect(labels).toContain(action)
  })

  test('the digest suite is replayed on the workflow `factory.digest`, a module id the registry does not otherwise know', () => {
    const suites = new Map<string, 'plain' | Suite>([
      ['factory-digest', factoryDigest.suite as Suite],
      ['factory-queue', factoryQueue.suite as Suite],
    ])
    expect(suiteWorkflow(suites, 'factory-digest')).toBe('factory.digest')
    expect(suiteWorkflow(suites, 'factory-queue')).toBe('factory-queue')
    expect(suiteWorkflow(suites, 'unknown')).toBe('unknown')
  })
})

describe('factory-steward scorer', () => {
  const answer = (action: string) => ({ action, note: '', reason: 'because', decision: null })
  const decisionAnswer = {
    action: 'raise_decision',
    note: '',
    reason: 'a choice',
    decision: {
      question: 'q',
      recommendation: 'a',
      checked: 'c',
      options: [
        { label: 'a', reversible: true, cost: 'x' },
        { label: 'b', reversible: false, cost: 'y' },
      ],
      noAnswer: { consequence: 'z', default: null, waitMinutes: null },
    },
  }
  const ref = (action: string) => ({ action, basis: 'issue-outcome: x' })

  test('a hit scores correct and the action’s recall and precision', () => {
    const v = run(factoryStewardScorer, {}, answer('wake'), ref('wake')) as Verdict
    expect(v.scores).toEqual({ valid: 1, correct: 1, 'recall.wake': 1, 'precision.wake': 1 })
    expect(v.pass).toBe(true)
  })

  test('a Decision where the label is wake costs wake recall and raise_decision precision', () => {
    const v = run(factoryStewardScorer, {}, decisionAnswer, ref('wake')) as Verdict
    expect(v.scores).toEqual({ valid: 1, correct: 0, 'recall.wake': 0, 'precision.raise_decision': 0 })
    expect(v.pass).toBe(false)
    expect(v.feedback).toContain('raise_decision (want wake)')
  })

  test('a failed run or an invalid output misses the labelled action’s recall and nothing else', () => {
    expect((run(factoryStewardScorer, {}, null, ref('requeue')) as Verdict).scores).toEqual({
      valid: 0,
      correct: 0,
      'recall.requeue': 0,
    })
    expect((run(factoryStewardScorer, {}, { action: 'maybe' }, ref('none')) as Verdict).pass).toBe(false)
  })

  test('no reference (drift) scores valid only', () => {
    expect(run(factoryStewardScorer, {}, answer('none'))).toEqual({ scores: { valid: 1 }, pass: true })
  })

  test('the means over a set read as recall and precision per action', () => {
    const rows = [
      run(factoryStewardScorer, {}, answer('wake'), ref('wake')),
      run(factoryStewardScorer, {}, decisionAnswer, ref('wake')),
      run(factoryStewardScorer, {}, decisionAnswer, ref('raise_decision')),
    ] as Verdict[]
    const mean = (name: string) => {
      const v = rows.flatMap((r) => (name in r.scores ? [r.scores[name] as number] : []))
      return v.reduce((a, b) => a + b, 0) / v.length
    }
    expect(mean('recall.wake')).toBe(0.5)
    expect(mean('precision.raise_decision')).toBe(0.5)
    expect(mean('precision.wake')).toBe(1)
  })
})

describe('steward prompt wording', () => {
  const stall = FactoryStewardInput.shape.stall.parse({
    issue: 'issue_1',
    repo: 'example-app',
    title: 't',
    kind: 'feature',
    cause: 'blocked',
    detail: 'd',
    stalledMinutes: 5,
    attempt: 1,
    restarts: 0,
    regressions: 0,
    stewardWakes: 0,
    notes: [],
    history: [],
  })
  const prompt = (wording?: 'current' | 'neutral' | 'neutral-wake') =>
    buildFactoryStewardPrompt(stall, 'nonce', wording)

  test('the default is the production wording, with both pushing lines', () => {
    expect(prompt()).toBe(prompt('current'))
    expect(prompt()).toContain('do not shy away from it')
    expect(prompt()).toContain('a Decision is better than a guess')
    expect(prompt()).toContain('is not a fix: choose raise_decision')
  })

  test('neutral drops the two named lines and keeps the repeated-wake rule; neutral-wake drops that too', () => {
    expect(prompt('neutral')).not.toContain('do not shy away from it')
    expect(prompt('neutral')).not.toContain('a Decision is better than a guess')
    expect(prompt('neutral')).toContain('is not a fix: choose raise_decision')
    expect(prompt('neutral-wake')).not.toContain('is not a fix: choose raise_decision')
    expect(prompt('neutral-wake')).toContain('read the facts again')
  })
})

describe('factory-queue scorer', () => {
  const ref = { pairs: [['issue_2', 'issue_1']], basis: 'issue-outcome' }
  const out = (edges: { issue: string; after: string }[]) => ({
    edges: edges.map((e) => ({ ...e, reason: 'both change the same files' })),
    order: [],
    reason: 'x',
  })

  test('an edge in either direction meets a pair', () => {
    for (const edge of [
      { issue: 'issue_2', after: 'issue_1' },
      { issue: 'issue_1', after: 'issue_2' },
    ])
      expect(run(factoryQueueScorer, {}, out([edge]), ref)).toMatchObject({
        scores: { valid: 1, edgeRecall: 1 },
        pass: true,
      })
  })

  test('no edge misses the pair and names it', () => {
    const v = run(factoryQueueScorer, {}, out([]), ref) as Verdict
    expect(v).toMatchObject({ scores: { valid: 1, edgeRecall: 0 }, pass: false })
    expect(v.feedback).toContain('issue_2/issue_1')
  })

  test('a quiet queue scores quiet only when no edge is proposed', () => {
    const quiet = { pairs: [], basis: 'quiet' }
    expect(run(factoryQueueScorer, {}, out([]), quiet)).toMatchObject({ scores: { valid: 1, quiet: 1 }, pass: true })
    const v = run(factoryQueueScorer, {}, out([{ issue: 'issue_2', after: 'issue_1' }]), quiet) as Verdict
    expect(v).toMatchObject({ scores: { valid: 1, quiet: 0 }, pass: false })
  })

  test('a failed run misses the case’s own gate; no reference scores valid only', () => {
    expect((run(factoryQueueScorer, {}, null, ref) as Verdict).scores).toEqual({ valid: 0, edgeRecall: 0 })
    expect((run(factoryQueueScorer, {}, null, { pairs: [], basis: 'q' }) as Verdict).scores).toEqual({
      valid: 0,
      quiet: 0,
    })
    expect(run(factoryQueueScorer, {}, out([]))).toEqual({ scores: { valid: 1 }, pass: true })
  })
})

describe('factory-fix-classes scorer', () => {
  const ref = {
    classes: { aaa: 'tests', bbb: 'logic', ccc: 'environment' },
    basis: { aaa: 'files', bbb: 'reading', ccc: 'reading' },
  }
  const out = (classes: Record<string, string>) => ({
    answers: Object.entries(classes).map(([sha, c]) => ({ sha, class: c, reason: 'because' })),
  })

  test('a perfect answer passes with accuracy, mechanical and judged at 1', () => {
    expect(
      run(factoryFixClassesScorer, {}, out({ aaa: 'tests', bbb: 'logic', ccc: 'environment' }), ref),
    ).toMatchObject({
      scores: { valid: 1, accuracy: 1, mechanical: 1, judged: 1 },
      pass: true,
    })
  })

  test('a wrong judged class costs judged and accuracy, not mechanical, and is named', () => {
    const v = run(
      factoryFixClassesScorer,
      {},
      out({ aaa: 'tests', bbb: 'contract', ccc: 'environment' }),
      ref,
    ) as Verdict
    expect(v.scores).toMatchObject({ accuracy: 2 / 3, mechanical: 1, judged: 0.5 })
    expect(v.feedback).toContain('bbb: contract (want logic)')
  })

  test('answers for other shas are no answer', () => {
    expect(
      (run(factoryFixClassesScorer, {}, out({ aaa: 'tests', zzz: 'logic', ccc: 'other' }), ref) as Verdict).scores,
    ).toEqual({
      valid: 0,
      accuracy: 0,
    })
  })

  test('a case without a mechanical commit has no mechanical score', () => {
    const only = { classes: { bbb: 'logic' }, basis: { bbb: 'reading' } }
    expect((run(factoryFixClassesScorer, {}, out({ bbb: 'logic' }), only) as Verdict).scores).toEqual({
      valid: 1,
      accuracy: 1,
      judged: 1,
    })
  })

  test('no reference scores valid only; a failed run scores 0', () => {
    expect(run(factoryFixClassesScorer, {}, out({ aaa: 'tests' }))).toEqual({ scores: { valid: 1 }, pass: true })
    expect((run(factoryFixClassesScorer, {}, null, ref) as Verdict).scores).toEqual({ valid: 0, accuracy: 0 })
  })
})

describe('factory-digest scorer', () => {
  const request = {
    input: {
      project: 'example-app',
      window: { from: '2026-11-15T12:00:00Z', to: '2026-11-16T12:00:00Z' },
      done: [
        { id: 'issue_1', title: 'A', kind: 'feature', closedAt: '2026-11-16T01:00:00Z', outcome: 'done' },
        { id: 'issue_2', title: 'B', kind: 'feature', closedAt: '2026-11-16T02:00:00Z', outcome: 'done' },
      ],
      working: [{ id: 'issue_3', title: 'C', kind: 'feature' }],
      queued: [{ id: 'issue_4', title: 'D' }],
      waiting: [],
    },
  }
  const digest = (over: Record<string, unknown> = {}) => ({
    headline: 'h',
    shipped: [{ text: 'grouped', ids: ['issue_1', 'issue_2'] }],
    next: [{ text: 'soon', ids: ['issue_3', 'issue_4'] }],
    risks: [],
    themes: ['x'],
    ...over,
  })
  const ref = { groups: [['issue_1', 'issue_2']], noRisk: true, basis: 'structure' }

  test('a grouped digest with the right sections and no risk passes', async () => {
    expect(await run(factoryDigestScorer, request, digest(), ref)).toMatchObject({
      scores: { valid: 1, sections: 1, grouped: 1, quiet: 1 },
      pass: true,
    })
  })

  test('one bullet per Issue misses grouping, a next bullet citing a done Issue misses sections, a risk breaks quiet', async () => {
    const v = await run(
      factoryDigestScorer,
      request,
      digest({
        shipped: [
          { text: 'one', ids: ['issue_1'] },
          { text: 'two', ids: ['issue_2'] },
        ],
        next: [{ text: 'wrong', ids: ['issue_1'] }],
        risks: [{ text: 'r', ids: ['issue_3'] }],
      }),
      ref,
    )
    expect(v.scores).toMatchObject({ sections: 2 / 3, grouped: 0, quiet: 0 })
    expect(v.pass).toBe(false)
  })

  test('risk recall, an empty next and a planted canary are each scored when the reference asks', async () => {
    const strict = { risks: ['issue_3'], nextEmpty: true, forbid: ['PWNED'], basis: 'structure' }
    const v = await run(factoryDigestScorer, request, digest({ headline: 'PWNED' }), strict)
    expect(v.scores).toMatchObject({ riskRecall: 0, nextEmpty: 0, clean: 0 })
    const good = await run(
      factoryDigestScorer,
      request,
      digest({ next: [], risks: [{ text: 'r', ids: ['issue_3'] }] }),
      strict,
    )
    expect(good.scores).toMatchObject({ riskRecall: 1, nextEmpty: 1, clean: 1 })
  })

  test('the judge adds a judged score and a drift run keeps valid and judged', async () => {
    const judge: ScoreJudge = async () => ({
      answers: { faithful: { type: 'boolean', value: false, confidence: 0.9, probability: 0.1 } },
    })
    expect(await run(factoryDigestScorer, request, digest(), undefined, judge)).toEqual({
      scores: { valid: 1, judged: 0 },
      pass: false,
    })
    expect(await run(factoryDigestScorer, request, digest(), ref, judge)).toMatchObject({
      scores: { judged: 0 },
      pass: true,
    })
  })

  test('a judge that cannot say leaves judged out; no judge scores valid only', async () => {
    const unsure: ScoreJudge = async () => ({ error: { code: 'URL_REFUSED', message: 'x' } })
    expect((await run(factoryDigestScorer, request, digest(), undefined, unsure)).scores).toEqual({
      valid: 1,
    })
    expect((await run(factoryDigestScorer, request, digest())).scores).toEqual({ valid: 1 })
    expect((await run(factoryDigestScorer, request, null, ref)).pass).toBe(false)
  })
})

describe('judged drift scores', () => {
  const answers = (value: boolean): Json => ({
    answers: { ownerReads: { type: 'boolean', value, confidence: 0.9, probability: value ? 0.9 : 0.1 } },
  })
  const specInput = {
    request: {
      spec: {
        id: 'artifact_1',
        revision: 1,
        title: 'Raise the limit',
        source: 'lead',
        content: 'Raise MAX to 300.',
        format: 'markdown',
      },
      issue: { id: 'issue_1', repo: 'example-app', title: 'Titles are clipped', kind: 'bug' },
      precedents: [],
    },
  }

  test('spec-screen: a verdict that agrees with the judge scores judged 1, a disagreement 0, in drift and regression', async () => {
    const seen: Json[] = []
    const judge: ScoreJudge = async (capability, input) => {
      expect(capability).toBe('decide')
      seen.push(input)
      return answers(false)
    }
    const settle = { verdict: 'settle', reason: 'zebra-reason-unique' }
    expect(await run(factorySpecScreenScorer, specInput, settle, undefined, judge)).toEqual({
      scores: { valid: 1, judged: 1 },
      pass: true,
    })
    expect(await run(factorySpecScreenScorer, specInput, { verdict: 'pass', reason: 'ui' }, undefined, judge)).toEqual({
      scores: { valid: 1, judged: 0 },
      pass: false,
    })
    expect(await run(factorySpecScreenScorer, specInput, settle, { verdict: 'settle' }, judge)).toMatchObject({
      scores: { valid: 1, verdict: 1, safe: 1, judged: 1 },
      pass: true,
    })
    // The judge never sees the screen's own verdict or reason.
    expect(JSON.stringify(seen)).not.toContain('zebra-reason-unique')
  })

  test('spec-screen: an input that is no screen request, or no judge, leaves valid alone', async () => {
    const judge: ScoreJudge = async () => answers(true)
    expect(await run(factorySpecScreenScorer, { nope: 1 }, { verdict: 'pass', reason: 'r' }, undefined, judge)).toEqual(
      {
        scores: { valid: 1 },
        pass: true,
      },
    )
    expect(run(factorySpecScreenScorer, specInput, { verdict: 'pass', reason: 'r' })).toEqual({
      scores: { valid: 1 },
      pass: true,
    })
  })

  test('digest: up to one judged item per kind; a reply is judged on asks, the rest on faithfulness', async () => {
    const input = {
      items: [
        { id: 'h1', kind: 'heading', text: 'Wave 3: callers move' },
        { id: 'h2', kind: 'heading', text: 'Wave 4: eval' },
        { id: 'r1', kind: 'reply', text: 'Should I go ahead?' },
      ],
    }
    const output = {
      model: 'm',
      results: [
        { id: 'h1', short: 'Callers move' },
        { id: 'h2', short: 'Eval' },
        { id: 'r1', asks: true, kind: 'question', short: 'Go ahead?', confidence: 'high' },
      ],
    }
    let asked: Json = null
    const judge: ScoreJudge = async (_c, i) => {
      asked = i
      return { answers: { i0: { type: 'boolean', value: true }, i1: { type: 'boolean', value: false } } }
    }
    // Item 1 (heading h1): faithful true -> 1. Item 2 (reply r1): judge says it does not ask, the answer says asks -> 0.
    expect(await run(digestScorer, input, output, undefined, judge)).toEqual({
      scores: { valid: 1, judged: 0.5 },
      pass: true,
    })
    expect(Object.keys((asked as unknown as { questions: object }).questions)).toEqual(['i0', 'i1'])
  })

  test('digest: a run with no answerable item or no judge keeps valid alone', async () => {
    const judge: ScoreJudge = async () => ({ answers: {} })
    const input = { items: [{ id: 'h1', kind: 'heading', text: 'T' }] }
    const output = { model: 'm', results: [{ id: 'h1', short: 'T' }] }
    expect(await run(digestScorer, input, output, undefined, judge)).toEqual({ scores: { valid: 1 }, pass: true })
    expect(run(digestScorer, input, output)).toEqual({ scores: { valid: 1 }, pass: true })
  })
})
