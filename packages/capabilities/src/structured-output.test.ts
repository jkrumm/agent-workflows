import { describe, expect, test } from 'bun:test'
import { fallbackRoute, resolveRoute, type RouteId } from '@agent-workflows/routes'
import { createCapabilities } from './capabilities/index.ts'
import { createRegistry } from './registry.ts'
import { fakeTransports } from './testing/index.ts'
import { isStrictCompatible } from './transports/index.ts'

// Every production schema passed to `completeJson`, driven through its capability so the test sees the schema the
// capability really builds (several are built per call). A schema change that makes `toJsonSchema` return null would
// silently turn structured output off for that capability; this fails instead.
const CASES: { capability: string; route: RouteId; input: Record<string, unknown> }[] = [
  {
    capability: 'factory.classify',
    route: 'factory.classify',
    input: { title: 't', facts: 'f', repo: 'argo', source: 'kuma', projects: ['argo'] },
  },
  { capability: 'review.route', route: 'review.router', input: { diff: '+x' } },
  { capability: 'triage', route: 'triage', input: { destination: 'd', transcript: 't' } },
  { capability: 'overview.classify', route: 'overview.classify', input: { facts: 'f', agentIds: ['a1'] } },
  { capability: 'llm.classify', route: 'cheap.classify', input: { text: 'x', labels: { bug: 'b', feature: 'f' } } },
  {
    capability: 'narrative.compose',
    route: 'narrative',
    input: {
      project: 'p',
      cwd: '/c',
      since: null,
      sinceUsed: 's',
      previousPage: null,
      commitsText: 'c',
      commitCount: 1,
      sessionsText: 's',
      sessionCount: 1,
    },
  },
  {
    capability: 'prose.critique',
    route: 'prose.review',
    input: {
      text: 'We ship.',
      medium: 'article',
      register: 'peer-technical',
      language: 'en',
      draftFormat: 'markdown',
      verdictFirst: true,
    },
  },
]

/** Optional properties: strict `json_schema` answers 400, so these go to a GPT fallback as JSON mode. */
const NOT_STRICT = ['review.route', 'prose.critique']

async function sentSchema(capability: string, input: Record<string, unknown>) {
  const transports = fakeTransports({ anthropic: [{ text: '{}' }], openai: [{ text: '{}' }] })
  const registry = createRegistry(createCapabilities({ transports, env: { AGW_VOICE_PATH: '/nonexistent' } }))
  // `{}` fits no schema: the call ends in INVALID_OUTPUT, after the request this test reads.
  await registry.call(capability as never, input as never, { addUsage() {} }).catch(() => undefined)
  return transports.chatCalls[0]?.request.jsonSchema
}

describe('every completeJson capability sends a JSON Schema', () => {
  for (const { capability, route, input } of CASES) {
    test(`${capability} (${route})`, async () => {
      const schema = await sentSchema(capability, input)
      expect(schema, `${capability} lost its wire schema`).toBeDefined()
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
      const fallback = fallbackRoute(resolveRoute(route, {}))
      if (fallback?.wire === 'iu-openai' && !NOT_STRICT.includes(capability)) {
        expect(
          isStrictCompatible(schema ?? {}),
          `${capability} no longer fits strict json_schema on its GPT fallback`,
        ).toBe(true)
      }
    })
  }

  test('the non-strict list is exactly the capabilities with an optional property', async () => {
    const notStrict: string[] = []
    for (const { capability, input } of CASES) {
      const schema = await sentSchema(capability, input)
      if (!isStrictCompatible(schema ?? {})) notStrict.push(capability)
    }
    expect(notStrict.sort()).toEqual([...NOT_STRICT].sort())
  })
})
