import { describe, expect, test } from 'bun:test'
import type { JudgeInput, LabelInput } from '@agent-workflows/eval'
import { createCapabilities } from './capabilities/index.ts'
import { JUDGE_SYSTEM, JUDGE_TEMPLATE, JUDGE_VERSION } from './capabilities/eval-judge.ts'
import {
  cutDiff,
  EVAL_DIFF_CHARS,
  LABEL_SYSTEM,
  LABEL_TEMPLATE,
  LABELER_VERSION,
  pinnedVersion,
} from './capabilities/eval-label.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError } from './errors.ts'
import { createRegistry } from './registry.ts'
import { type FakeTransports, fakeTransports } from './testing/index.ts'

function setup(script: Parameters<typeof fakeTransports>[0]) {
  const transports: FakeTransports = fakeTransports(script)
  const registry = createRegistry(createCapabilities({ transports, env: {} }))
  const usages: Usage[] = []
  const options = { addUsage: (usage: Usage) => usages.push(usage) }
  return { transports, registry, usages, options }
}

const caught = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CapabilityCallError)
  return error as CapabilityCallError
}

const sha = 'a'.repeat(40)
const diffOf = (file: string, chars: number) => `diff --git a/${file} b/${file}\n@@ -1 +1,2 @@\n+${'x'.repeat(chars)}\n`

const labelInput = (over: Partial<LabelInput> = {}): LabelInput => ({
  seat: 'a',
  candidateId: `repo-${sha.slice(0, 10)}-${sha.slice(0, 10)}`,
  introSubject: 'feat: parse ranges',
  introBody: '',
  introDiff: diffOf('src/range.ts', 20),
  fixSubject: 'fix: off by one',
  fixBody: 'the end was exclusive',
  fixDiff: diffOf('src/range.ts', 10),
  blamed: [{ file: 'src/range.ts', line: 2 }],
  ...over,
})

const DEFECT = {
  defect: true,
  location: { file: 'src/range.ts', startLine: 2, endLine: 3 },
  description: 'The end index is exclusive, so the last element is dropped.',
  bugClass: 'edge-case',
  severity: 'major',
  reason: 'The fix makes the end inclusive.',
} as const

describe('eval.label', () => {
  test('seat a runs on the anthropic wire, seat b on the chat wire; the answer carries the model', async () => {
    const t = setup({ anthropic: [{ text: JSON.stringify(DEFECT) }], openai: [{ text: JSON.stringify(DEFECT) }] })
    const a = await t.registry.call('eval.label', labelInput({ seat: 'a' }), t.options)
    const b = await t.registry.call('eval.label', labelInput({ seat: 'b' }), t.options)
    expect(t.transports.chatCalls.map((c) => c.wire)).toEqual(['anthropic', 'openai'])
    expect(a).toEqual({ ...DEFECT, model: t.transports.chatCalls[0]?.request.model ?? '' })
    expect(b.model).toBe(t.transports.chatCalls[1]?.request.model ?? '')
    expect(a.model).not.toBe(b.model)
    expect(t.transports.chatCalls.map((c) => c.request.effort)).toEqual(['medium', 'medium'])
    expect(t.transports.chatCalls.map((c) => c.request.maxOutputTokens)).toEqual([16_000, 16_000])
  })

  test('the schema goes to the wire as structured output and is enforced: a defect without a location is re-asked, then rejected', async () => {
    const t = setup({ anthropic: [{ text: JSON.stringify({ ...DEFECT, location: null }) }] })
    const error = await caught(t.registry.call('eval.label', labelInput(), t.options))
    expect(error.code).toBe('INVALID_OUTPUT')
    expect(t.transports.chatCalls).toHaveLength(2)
    expect(t.transports.chatCalls[0]?.request.jsonSchema).toMatchObject({ type: 'object' })
    expect(t.transports.chatCalls[1]?.request.prompt).toContain('RETRY')
  })

  test('a non-defect answers with a null location', async () => {
    const no = { ...DEFECT, defect: false, location: null, reason: 'A renamed variable.' }
    const t = setup({ anthropic: [{ text: JSON.stringify(no) }] })
    expect(await t.registry.call('eval.label', labelInput(), t.options)).toMatchObject({
      defect: false,
      location: null,
    })
  })

  test('a drained credit fails the call: the seat has no fallback', async () => {
    const t = setup({ anthropic: [new Error('boom')] })
    await caught(t.registry.call('eval.label', labelInput(), t.options))
    expect(t.transports.chatCalls.map((c) => c.wire)).toEqual(['anthropic'])
  })

  test('a diff over the cap is cut at a file boundary and the prompt says how much', async () => {
    const big = diffOf('a.ts', 40_000) + diffOf('b.ts', 40_000) + diffOf('c.ts', 10)
    const t = setup({ anthropic: [{ text: JSON.stringify(DEFECT) }] })
    await t.registry.call('eval.label', labelInput({ introDiff: big }), t.options)
    const prompt = t.transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('a/a.ts')
    expect(prompt).not.toContain('a/b.ts')
    expect(prompt).toContain(
      `[diff cut: ${big.length - diffOf('a.ts', 40_000).length} of ${big.length} characters omitted, 1 of 3 file sections kept whole]`,
    )
    // the fix diff was under the cap
    expect(prompt.match(/\[diff cut:/g)).toHaveLength(1)
  })

  test('cutDiff: nothing cut under the cap; a first file over the cap is cut mid-way', () => {
    expect(cutDiff('small')).toEqual({ text: 'small', notice: '' })
    const one = diffOf('a.ts', EVAL_DIFF_CHARS + 5)
    const cut = cutDiff(one)
    expect(cut.text).toHaveLength(EVAL_DIFF_CHARS)
    expect(cut.notice).toContain('the first file is cut mid-way')
  })

  test('the prompt carries the commit text, the blamed hint and the diffs as fenced data', async () => {
    const t = setup({ anthropic: [{ text: JSON.stringify(DEFECT) }] })
    await t.registry.call(
      'eval.label',
      labelInput({ introDiff: 'diff --git a/q b/q\n+$& {{fixSubject}}\n' }),
      t.options,
    )
    const prompt = t.transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('src/range.ts:2')
    expect(prompt).toContain('fix: off by one')
    expect(prompt).toContain('+$& {{fixSubject}}')
    expect(prompt).toMatch(/<<<INTRO_DIFF_[0-9a-f]{12}_BEGIN>>>/)
  })

  test('LABELER_VERSION is the pinned hash of the prompt, the system text and both seats’ model and effort', () => {
    expect(LABELER_VERSION).toBe(
      pinnedVersion('eval-label', `${LABEL_SYSTEM}\n${LABEL_TEMPLATE}`, ['eval.label.a', 'eval.label.b']),
    )
  })
})

const finding = (id: string, message = 'a problem') => ({
  id,
  tag: 'important' as const,
  file: 'src/range.ts',
  line: 2,
  message,
})
const BUG = {
  location: { file: 'src/range.ts', startLine: 2, endLine: 3 },
  description: 'The last element is dropped.',
}
const judgeInput = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  caseId: 'c1',
  bug: BUG,
  findings: [finding('0'), finding('1')],
  preselected: ['0'],
  diff: diffOf('src/range.ts', 20),
  ...over,
})
const verdicts = (...entries: [string, string][]) =>
  JSON.stringify({ findings: entries.map(([id, cls]) => ({ id, class: cls, reason: `because ${cls}` })) })

describe('eval.judge', () => {
  test('classifies every finding on the pinned judge route and returns them in input order', async () => {
    const t = setup({ anthropic: [{ text: verdicts(['1', 'real'], ['0', 'match']) }] })
    const out = await t.registry.call('eval.judge', judgeInput(), t.options)
    const request = t.transports.chatCalls[0]?.request
    expect(out).toEqual({
      findings: [
        { id: '0', class: 'match', reason: 'because match' },
        { id: '1', class: 'real', reason: 'because real' },
      ],
      model: request?.model ?? '',
    })
    expect(t.transports.chatCalls[0]?.wire).toBe('anthropic')
    expect(request).toMatchObject({ effort: 'medium', maxOutputTokens: 16_000 })
    expect(request?.prompt).toContain('right file and lines, wrong defect')
    expect(request?.prompt).toContain('Preselected finding ids (the only ones that may be "match"): 0')
  })

  test('a match on a finding that was not preselected becomes unclear, with the refusal in its reason', async () => {
    const t = setup({ anthropic: [{ text: verdicts(['0', 'match'], ['1', 'match']) }] })
    const out = await t.registry.call('eval.judge', judgeInput(), t.options)
    expect(out.findings[0]?.class).toBe('match')
    expect(out.findings[1]).toEqual({
      id: '1',
      class: 'unclear',
      reason: 'because match [match refused: not a preselected finding]',
    })
  })

  test('exactly one entry per finding id: a missing, extra or repeated id is re-asked, then INVALID_OUTPUT', async () => {
    for (const bad of [
      verdicts(['0', 'match']),
      verdicts(['0', 'match'], ['1', 'real'], ['9', 'nit']),
      verdicts(['0', 'match'], ['0', 'real'], ['1', 'nit']),
    ]) {
      const t = setup({ anthropic: [{ text: bad }] })
      const error = await caught(t.registry.call('eval.judge', judgeInput(), t.options))
      expect(error.code).toBe('INVALID_OUTPUT')
      expect(t.transports.chatCalls).toHaveLength(2)
    }
  })

  test('a re-ask that repairs the id set succeeds', async () => {
    const t = setup({
      anthropic: [{ text: verdicts(['0', 'match']) }, { text: verdicts(['0', 'match'], ['1', 'nit']) }],
    })
    const out = await t.registry.call('eval.judge', judgeInput(), t.options)
    expect(out.findings.map((f) => f.class)).toEqual(['match', 'nit'])
  })

  test('a control has only the four non-match classes: a match is rejected by the schema', async () => {
    const control = judgeInput({ bug: null, preselected: [] })
    const ok = setup({ anthropic: [{ text: verdicts(['0', 'nit'], ['1', 'not-a-bug']) }] })
    expect((await ok.registry.call('eval.judge', control, ok.options)).findings.map((f) => f.class)).toEqual([
      'nit',
      'not-a-bug',
    ])
    expect(ok.transports.chatCalls[0]?.request.prompt).toContain('clean control')

    const bad = setup({ anthropic: [{ text: verdicts(['0', 'match'], ['1', 'nit']) }] })
    expect((await caught(bad.registry.call('eval.judge', control, bad.options))).code).toBe('INVALID_OUTPUT')
  })

  test('zero findings return an empty answer with no model call', async () => {
    const t = setup({ anthropic: [new Error('must not be called')] })
    const out = await t.registry.call('eval.judge', judgeInput({ findings: [], preselected: [] }), t.options)
    expect(out).toEqual({ findings: [], model: '' })
    expect(t.transports.chatCalls).toHaveLength(0)
    expect(t.usages).toHaveLength(0)
  })

  test('the diff is cut to the cap with a notice', async () => {
    const big = diffOf('a.ts', 40_000) + diffOf('b.ts', 40_000)
    const t = setup({ anthropic: [{ text: verdicts(['0', 'match'], ['1', 'nit']) }] })
    await t.registry.call('eval.judge', judgeInput({ diff: big }), t.options)
    const prompt = t.transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).not.toContain('a/b.ts')
    expect(prompt).toContain('1 of 2 file sections kept whole')
  })

  test('JUDGE_VERSION is the pinned hash of the prompt, the system text and the judge seat’s model and effort', () => {
    expect(JUDGE_VERSION).toBe(pinnedVersion('eval-judge', `${JUDGE_SYSTEM}\n${JUDGE_TEMPLATE}`, ['eval.judge']))
  })
})
