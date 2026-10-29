import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineCapability } from './procedure.ts'
import { createRegistry } from './registry.ts'

const served = defineCapability({
  id: 'demo.served',
  summary: 'a served capability',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  handler: ({ n }) => ({ n: n + 1 }),
})
const hidden = defineCapability({
  id: 'demo.metered',
  summary: 'a metered seat whose guards live in a workflow',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  internal: true,
  handler: ({ n }) => ({ n: n * 10 }),
})

describe('an internal capability', () => {
  const registry = createRegistry([served, hidden] as const)

  test('answers in process: `call` through the registry and its own', async () => {
    expect(await registry.call('demo.metered', { n: 2 })).toEqual({ n: 20 })
    expect(await hidden.call({ n: 3 })).toEqual({ n: 30 })
    expect(registry.ids()).toEqual(['demo.served', 'demo.metered'])
  })

  test('has no route: HTTP is a 404, while the served one answers', async () => {
    const post = (path: string) =>
      registry.fetch(
        new Request(`http://x${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ n: 1 }),
        }),
      )
    expect((await post('/demo/served')).status).toBe(200)
    expect((await post('/demo/metered')).status).toBe(404)
  })

  test('is not in the router or the OpenAPI document, so the CLI has no command for it', async () => {
    expect(Object.keys(registry.router.demo as object)).toEqual(['served'])
    const doc = (await registry.openapi()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(['/demo/served'])
    expect(JSON.stringify(doc)).not.toContain('demoMetered')
  })

  test('shares no route with a served capability: the path is free', () => {
    const twin = defineCapability({
      id: 'demo.twin',
      summary: 'x',
      input: z.object({}),
      output: z.object({}),
      route: { path: '/demo/served' },
      internal: true,
      handler: () => ({}),
    })
    expect(() => createRegistry([served, twin] as const)).not.toThrow()
  })
})
