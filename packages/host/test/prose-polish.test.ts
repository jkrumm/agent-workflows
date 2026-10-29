import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { createProsePolish } from '../src/workflows/prose-polish/index.ts'
import { ProsePolishOutput } from '../src/workflows/prose-polish/schema.ts'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'
import { rejection } from './support.ts'

const dir = mkdtempSync(join(tmpdir(), 'agw-prose-polish-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const VOICE = join(dir, 'voice.md')
writeFileSync(VOICE, 'SECRET-VOICE-RULES: write plainly.')

const SCORES = {
  verdict_first: 4,
  structure: 3,
  no_repetition: 5,
  concision: 4,
  precision: 4,
  clarity: 4,
  visual_fit: 3,
  naturalness: 4,
  engagement: 3,
}
const REVIEW = {
  scores: SCORES,
  notes: [{ criterion: 'concision', note: 'The second paragraph restates the first.' }],
  visualSuggestions: [{ kind: 'table', shows: 'the options', where: 'section 2' }],
}

const DRAFT = [
  '# Release notes',
  '',
  'We leverage the new cache. See https://example.com/docs/cache for details.',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  'The cache is faster.',
].join('\n')
// Same facts, no banned word.
const REWRITE = DRAFT.replace('We leverage the new cache.', 'We use the new cache.')

type Script = Parameters<typeof fakeTransports>[0]

function setup(script: Script = {}, env: Record<string, string> = { AGW_VOICE_PATH: VOICE }) {
  const transports = fakeTransports({
    openai: [{ text: JSON.stringify(REVIEW), cost: 0.002 }],
    anthropic: [{ text: REWRITE, cost: 0.05 }],
    ...script,
  })
  const registry = createRegistry(createCapabilities({ transports, env }))
  const { workflow } = createProsePolish({ registry, env })
  return { transports, workflow, writes: () => transports.chatCalls.filter((c) => c.wire === 'anthropic') }
}

const db = freshSchema('prose_polish')
async function run(workflow: ReturnType<typeof setup>['workflow'], input: Record<string, unknown>) {
  const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
  await rt.open()
  try {
    const { runId } = await rt.start(workflow, input, { purpose: 'build' })
    return await rt.wait(runId)
  } finally {
    await rt.close()
  }
}

describe('prose-polish', () => {
  test('lint, review, rewrite and the gate: the rewrite is kept, with the models and the summed cost', async () => {
    const w = setup()
    const result = await run(w.workflow, { text: DRAFT, medium: 'article' })
    expect(result.status).toBe('done')
    const out = ProsePolishOutput.parse(result.output)
    expect(out.kept).toBe('rewrite')
    expect(out.text).toBe(REWRITE)
    expect(out.reason).toBeUndefined()
    expect(out.language).toBe('en')
    expect(out.format).toBe('markdown')
    expect(out.mediumNote).toBe('Narrative paragraphs; the h-level sections are kept.')
    expect(out.lint.before).toBe(1)
    expect(out.lint.after).toBe(0)
    expect(out.lint.findings).toEqual([])
    expect(out.review.scores).toEqual(SCORES)
    expect(out.review.notes).toEqual(REVIEW.notes)
    expect(out.visualSuggestions).toEqual(REVIEW.visualSuggestions)
    expect(out.models.reviewer).toBeTruthy()
    expect(out.models.writer).toBeTruthy()
    expect(out.cost).toBeCloseTo(0.052, 6)
    expect(w.transports.chatCalls.map((c) => c.wire)).toEqual(['openai', 'anthropic'])
  })

  test('the writer gets the voice guide, the lint findings and the reviewer notes, fenced', async () => {
    const w = setup()
    await run(w.workflow, { text: DRAFT, medium: 'article', brief: 'For the on-call engineer' })
    const sent = w.writes()[0]?.request
    expect(sent?.system).toContain('SECRET-VOICE-RULES')
    expect(sent?.prompt).toMatch(/<<<LINT_FINDINGS_[0-9a-f]{32}_BEGIN>>>\n- line 3 \[banned-leverage\]/)
    expect(sent?.prompt).toMatch(/<<<REVIEWER_NOTES_[0-9a-f]{32}_BEGIN>>>\n- concision: The second paragraph/)
    expect(sent?.prompt).toMatch(/<<<BRIEF_[0-9a-f]{32}_BEGIN>>>\nFor the on-call engineer\n/)
    expect(sent?.prompt).toMatch(/<<<DRAFT_[0-9a-f]{32}_BEGIN>>>\n# Release notes/)
  })

  test('a rewrite the gate refuses keeps the original byte for byte, with the gate’s reason and the original’s lint', async () => {
    const w = setup({ anthropic: [{ text: `${REWRITE}\n\nSee https://example.com/invented.`, cost: 0.05 }] })
    const out = ProsePolishOutput.parse((await run(w.workflow, { text: DRAFT, medium: 'article' })).output)
    expect(out.kept).toBe('original')
    expect(out.text).toBe(DRAFT)
    expect(out.reason).toContain('rewrite added the URL')
    expect(out.lint.after).toBe(out.lint.before)
    expect(out.lint.findings.map((f) => f.rule)).toContain('banned-leverage')
    // The writer was paid for regardless.
    expect(out.cost).toBeCloseTo(0.052, 6)
  })

  test.each([
    ['empty text', { text: '' }, 'writer returned empty text'],
    ['a truncated answer', { text: 'half a sent', stop: 'length' as const }, 'writer failed: the answer stops mid-way'],
  ])('%s from the writer keeps the original with the writer’s reason', async (_name, reply, reason) => {
    const w = setup({ anthropic: [{ ...reply, cost: 0.01 }] })
    const result = await run(w.workflow, { text: DRAFT, medium: 'article' })
    expect(result.status).toBe('done')
    const out = ProsePolishOutput.parse(result.output)
    expect(out.kept).toBe('original')
    expect(out.text).toBe(DRAFT)
    expect(out.reason).toBe(reason)
  })

  test('a long bad draft (more findings than the writer lists) is not a failed run: the first 50 are sent, the rest counted', async () => {
    const bad = Array.from({ length: 120 }, (_, i) => `We leverage cache ${i}.`).join('\n\n')
    const w = setup({ anthropic: [{ text: bad.replaceAll('leverage', 'use'), cost: 0.05 }] })
    const result = await run(w.workflow, { text: bad, medium: 'article' })
    expect(result.status).toBe('done')
    const out = ProsePolishOutput.parse(result.output)
    expect(out.kept).toBe('rewrite')
    expect(out.lint.before).toBe(120)
    const prompt = w.writes()[0]?.request.prompt ?? ''
    expect(prompt.match(/^- line \d+ \[banned-leverage\]/gm)).toHaveLength(50)
    expect(prompt).toContain('- … and 70 more')
  })

  test('verdictFirst false reaches the writer and the review', async () => {
    const w = setup({
      openai: [{ text: JSON.stringify({ ...REVIEW, scores: { ...SCORES, verdict_first: undefined } }) }],
    })
    const out = ProsePolishOutput.parse(
      (await run(w.workflow, { text: DRAFT, medium: 'article', verdictFirst: false })).output,
    )
    expect(out.review.scores).not.toHaveProperty('verdict_first')
    expect(w.writes()[0]?.request.system).toContain("Keep the author's section order.")
  })

  test('a writer transport failure fails the run: an infra failure is not a verdict on the draft', async () => {
    const w = setup({ anthropic: [new Error('connection reset')] })
    const result = await run(w.workflow, { text: DRAFT, medium: 'article' })
    expect(result.status).toBe('failed')
  })

  test('a reviewer failure fails the run before the writer is paid', async () => {
    const w = setup({ openai: [new Error('connection reset')] })
    const result = await run(w.workflow, { text: DRAFT, medium: 'article' })
    expect(result.status).toBe('failed')
    expect(w.writes()).toHaveLength(0)
  })

  test('a missing voice guide fails before any model call', async () => {
    const w = setup({}, { AGW_VOICE_PATH: join(dir, 'missing.md') })
    const result = await run(w.workflow, { text: DRAFT, medium: 'article' })
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('AGW_VOICE_PATH')
    expect(w.transports.chatCalls).toHaveLength(0)
  })

  test('a blank draft is refused at admission', async () => {
    const w = setup()
    expect(await rejection(run(w.workflow, { text: '   ', medium: 'article' }))).toContain('must not be empty')
    expect(w.transports.chatCalls).toHaveLength(0)
  })

  test('is a CLI command beside `prose` and `prose-gate`', () => {
    const entry = createProsePolish({
      registry: createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} })),
    })
    expect(entry.workflow.id).toBe('prose-polish')
    expect(entry.cli).toMatchObject({ positional: ['text'], stdin: 'text' })
  })
})
