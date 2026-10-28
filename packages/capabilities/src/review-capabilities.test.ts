import { describe, expect, test } from 'bun:test'
import { createCapabilities } from './capabilities/index.ts'
import { MAX_DIFF_CHARS } from './capabilities/review-prompts.ts'
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

describe('review.route', () => {
  test('keeps the known router angles once, in order, with the depth; the diff is fenced as data', async () => {
    const t = setup({
      openai: [
        {
          text: JSON.stringify({
            angles: ['resilience', 'architect', 'security', 'resilience', 'made-up'],
            rationale: 'persisted state',
            depth: 'deep',
            depthReason: 'auth boundary',
          }),
        },
      ],
    })
    const out = await t.registry.call('review.route', { diff: 'diff --git a/x b/x\n+x' }, t.options)
    expect(out).toEqual({
      angles: ['resilience', 'security'],
      rationale: 'persisted state',
      depth: 'deep',
      depthReason: 'auth boundary',
      truncatedChars: 0,
    })
    const [call] = t.transports.chatCalls
    expect(call?.wire).toBe('openai')
    expect(call?.request.prompt).not.toContain('[GIT_DIFF_COMMAND]')
    expect(call?.request.prompt).toMatch(
      /<<<DIFF_[0-9a-f]{12}_BEGIN>>>\ndiff --git a\/x b\/x\n\+x\n<<<DIFF_[0-9a-f]{12}_END>>>/,
    )
    expect(t.usages).toHaveLength(1)
  })

  test('a missing or unknown depth is absent, not an error', async () => {
    const t = setup({ openai: [{ text: '{"angles":[],"depth":"extreme"}' }] })
    expect(await t.registry.call('review.route', { diff: '+x' }, t.options)).toEqual({ angles: [], truncatedChars: 0 })
  })

  test('the same diff renders the same prompt (a replayed step re-sends what it sent)', async () => {
    const t = setup({ openai: [{ text: '{"angles":[]}' }] })
    await t.registry.call('review.route', { diff: '+same' }, t.options)
    await t.registry.call('review.route', { diff: '+same' }, t.options)
    const [first, second] = t.transports.chatCalls
    expect(first?.request.prompt).toBe(second?.request.prompt as string)
  })

  test('a diff past the cap is cut and says so', async () => {
    const t = setup({ openai: [{ text: '{"angles":[]}' }] })
    const out = await t.registry.call('review.route', { diff: 'x'.repeat(MAX_DIFF_CHARS + 50) }, t.options)
    expect(out.truncatedChars).toBe(50)
    expect(t.transports.chatCalls[0]?.request.prompt).toContain(`[diff truncated at ${MAX_DIFF_CHARS} chars]`)
  })

  test('prose twice is INVALID_OUTPUT after one re-ask', async () => {
    const t = setup({ openai: [{ text: 'Here you go' }] })
    const error = await caught(t.registry.call('review.route', { diff: '+x' }, t.options))
    expect(error.code).toBe('INVALID_OUTPUT')
    expect(t.transports.chatCalls).toHaveLength(2)
  })
})

describe('review.adversary', () => {
  const finding = { severity: 'blocking' as const, file: 'a.ts', line: 3, message: 'drops the last row' }

  test('one call at medium effort with the diff and the author context; no temperature', async () => {
    const t = setup({ openai: [{ text: JSON.stringify({ findings: [finding] }), cost: 0.013 }] })
    const out = await t.registry.call('review.adversary', { diff: '+added line', context: 'add retry' }, t.options)
    expect(out.findings).toEqual([finding])
    expect(out.truncatedChars).toBe(0)
    const request = t.transports.chatCalls[0]?.request
    expect(request?.effort).toBe('medium')
    expect(request?.prompt).toContain('+added line')
    expect(request?.prompt).toContain('> add retry')
    expect(request?.prompt).not.toContain('[DIFF]')
    expect(request?.prompt).not.toContain('[CONTEXT_BLOCK]')
    expect(request).not.toHaveProperty('temperature')
    expect(t.usages).toEqual([expect.objectContaining({ cost: 0.013, costSource: 'provider' })])
  })

  test('an empty answer is retried once at low effort; both calls are billed', async () => {
    const t = setup({ openai: [{ text: '', stop: 'length' }, { text: '{"findings":[]}' }] })
    const out = await t.registry.call('review.adversary', { diff: '+x' }, t.options)
    expect(out.findings).toEqual([])
    expect(t.transports.chatCalls.map((c) => c.request.effort)).toEqual(['medium', 'low'])
    expect(t.usages).toHaveLength(2)
  })

  test('empty twice is UPSTREAM_ERROR', async () => {
    const t = setup({ openai: [{ text: '' }] })
    const error = await caught(t.registry.call('review.adversary', { diff: '+x' }, t.options))
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(t.transports.chatCalls).toHaveLength(2)
  })

  test('prose and a wrong shape are INVALID_OUTPUT; the first is not re-asked', async () => {
    const prose = setup({ openai: [{ text: 'looks fine to me' }] })
    expect((await caught(prose.registry.call('review.adversary', { diff: '+x' }, prose.options))).code).toBe(
      'INVALID_OUTPUT',
    )
    expect(prose.transports.chatCalls).toHaveLength(1)
    const shape = setup({ openai: [{ text: '{"findings":[{"file":"a.ts"}]}' }] })
    expect((await caught(shape.registry.call('review.adversary', { diff: '+x' }, shape.options))).code).toBe(
      'INVALID_OUTPUT',
    )
  })

  test('a fenced answer parses', async () => {
    const t = setup({ openai: [{ text: `\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\`` }] })
    const out = await t.registry.call('review.adversary', { diff: '+x' }, t.options)
    expect(out.findings).toHaveLength(1)
  })

  test('a diff past the cap is cut and says so', async () => {
    const t = setup({ openai: [{ text: '{"findings":[]}' }] })
    const out = await t.registry.call('review.adversary', { diff: 'y'.repeat(MAX_DIFF_CHARS + 7) }, t.options)
    expect(out.truncatedChars).toBe(7)
    expect(t.transports.chatCalls[0]?.request.prompt).toContain('[diff truncated at')
  })
})
