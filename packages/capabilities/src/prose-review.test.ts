import { describe, expect, test } from 'bun:test'
import { createCapabilities } from './capabilities/index.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError, CapabilityError } from './errors.ts'
import { createRegistry } from './registry.ts'
import { fakeTransports } from './testing/index.ts'

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

function setup(script: Parameters<typeof fakeTransports>[0], env: Record<string, string> = {}) {
  const transports = fakeTransports(script)
  const registry = createRegistry(createCapabilities({ transports, env }))
  const usages: Usage[] = []
  return { transports, registry, usages, options: { addUsage: (usage: Usage) => usages.push(usage) } }
}

describe('prose.critique', () => {
  test('returns the validated review and the model that answered; one billed call', async () => {
    const review = {
      scores: SCORES,
      notes: [{ criterion: 'concision' as const, note: 'The third paragraph restates the second.' }],
      visualSuggestions: [{ kind: 'table' as const, shows: 'the three options', where: 'section 2' }],
    }
    const t = setup({ openai: [{ text: JSON.stringify(review), cost: 0.004 }] })
    const out = await t.registry.call('prose.critique', { prompt: 'review this', verdictFirst: true }, t.options)
    expect(out.scores).toEqual(SCORES)
    expect(out.notes).toEqual(review.notes)
    expect(out.visualSuggestions).toEqual(review.visualSuggestions)
    expect(t.transports.chatCalls).toHaveLength(1)
    expect(t.transports.chatCalls[0]?.wire).toBe('openai')
    expect(t.usages).toHaveLength(1)
  })

  test('verdictFirst false: the verdict score and its notes are dropped by code, whatever the reviewer sent', async () => {
    const review = {
      scores: SCORES,
      notes: [
        { criterion: 'verdict_first', note: 'The verdict comes last.' },
        { criterion: 'clarity', note: 'Two ideas in the second sentence.' },
      ],
      visualSuggestions: [],
    }
    const t = setup({ openai: [{ text: JSON.stringify(review) }] })
    const out = await t.registry.call('prose.critique', { prompt: 'x', verdictFirst: false }, t.options)
    expect(out.scores).not.toHaveProperty('verdict_first')
    expect(out.notes).toEqual([{ criterion: 'clarity', note: 'Two ideas in the second sentence.' }])
  })

  test('verdictFirst true without a verdict score is re-asked once, then INVALID_OUTPUT', async () => {
    const { verdict_first: _omitted, ...scores } = SCORES
    const t = setup({ openai: [{ text: JSON.stringify({ scores, notes: [], visualSuggestions: [] }) }] })
    const error = await t.registry.call('prose.critique', { prompt: 'x', verdictFirst: true }, t.options).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(CapabilityCallError)
    expect((error as CapabilityCallError).code).toBe('INVALID_OUTPUT')
    expect(t.transports.chatCalls).toHaveLength(2)
  })

  test('a score out of range is rejected', async () => {
    const t = setup({
      openai: [{ text: JSON.stringify({ scores: { ...SCORES, clarity: 9 }, notes: [], visualSuggestions: [] }) }],
    })
    const error = await t.registry.call('prose.critique', { prompt: 'x', verdictFirst: true }, t.options).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as CapabilityCallError).code).toBe('INVALID_OUTPUT')
  })
})

describe('prose.review route: the reviewer is never the writer’s lab', () => {
  const noCalls = fakeTransports({})
  const build = (routes: object) => () =>
    createCapabilities({ transports: noCalls, env: { AGW_ROUTES: JSON.stringify(routes) } })

  test('the default route is not Anthropic, so the capabilities build', () => {
    expect(() => createCapabilities({ transports: noCalls, env: {} })).not.toThrow()
  })

  test('an Anthropic primary model is refused at definition time', () => {
    expect(build({ 'prose.review': { model: 'claude-test-model' } })).toThrow(CapabilityError)
    expect(build({ 'prose.review': { model: 'claude-test-model' } })).toThrow(/writer's lab/)
  })

  test('a malformed override is not this check’s to report: the capabilities still build', () => {
    expect(() => createCapabilities({ transports: noCalls, env: { AGW_ROUTES: '{nope' } })).not.toThrow()
  })

  test('a vendor-prefixed Anthropic id is refused too', () => {
    expect(build({ 'prose.review': { model: 'anthropic/claude-test-model' } })).toThrow(/writer's lab/)
  })

  test('an Anthropic fallback model is refused too', () => {
    expect(build({ 'prose.review': { fallback: { model: 'claude-test-model' } } })).toThrow(/writer's lab/)
  })
})
