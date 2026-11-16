import { describe, expect, test } from 'bun:test'
import { defineCapability, fail } from '@agent-workflows/capabilities'
import { z } from 'zod'
import { createCapabilityWorkflows } from '../src/capability-runs.ts'

const legs = [
  { leg: 'direct', ms: 30, outcome: 'blocked' },
  { leg: 'browser', ms: 400, outcome: 'ok', waitMs: 12 },
] as const

/** A `web.fetch` that answers from the browser leg, or fails as the chain does when a page stays walled. */
const webFetch = defineCapability({
  id: 'web.fetch',
  summary: 'fake',
  input: z.object({ url: z.string() }),
  output: z.object({
    via: z.enum(['direct', 'browser', 'tavily-extract']),
    cached: z.boolean(),
    wallMs: z.number(),
    legs: z.array(z.object({ leg: z.string(), ms: z.number(), outcome: z.string(), waitMs: z.number().optional() })),
  }),
  handler: ({ url }) => {
    if (url.includes('walled'))
      throw fail('UPSTREAM_ERROR', 'web.fetch: blocked (cloudflare-challenge) · direct: HTTP 403', {
        status: 403,
        wallMs: 90,
        legs: [{ leg: 'direct', ms: 80, outcome: 'blocked' }],
      })
    return { via: 'browser' as const, cached: false, wallMs: 450, legs: [...legs] }
  },
})

const other = defineCapability({
  id: 'web.search',
  summary: 'fake',
  input: z.object({ query: z.string() }),
  output: z.object({ n: z.number() }),
  handler: () => ({ n: 1 }),
})

/** Runs the `cap.<id>` workflow's body as the runtime would: one `call` step. */
async function runCap(id: string, input: unknown) {
  const seen: { runId: string; attributes: Record<string, unknown> }[] = []
  const workflows = createCapabilityWorkflows({ served: [webFetch, other] }, (runId, attributes) =>
    seen.push({ runId, attributes }),
  )
  const ctx = {
    runId: 'run-1',
    step: (_id: string, fn: (scope: unknown) => unknown) =>
      fn({ callContext: { addUsage: () => {}, signal: new AbortController().signal } }),
  }
  const outcome = await (workflows.get(id)!.run as (ctx: unknown, input: unknown) => Promise<unknown>)(ctx, input).then(
    () => 'ok',
    () => 'failed',
  )
  return { seen, outcome }
}

describe('cap.web.fetch span attributes', () => {
  test('a read carries its host, answering leg and cache flag, and nothing of the path or query', async () => {
    const { seen, outcome } = await runCap('web.fetch', { url: 'https://Shop.Example.com/a/b?token=SECRET#x' })
    expect(outcome).toBe('ok')
    expect(seen).toEqual([
      {
        runId: 'run-1',
        attributes: {
          'agw.web.host': 'shop.example.com',
          'agw.web.leg': 'browser',
          'agw.web.cached': false,
          'agw.web.blocked': undefined,
        },
      },
    ])
    expect(JSON.stringify(seen)).not.toMatch(/SECRET|\/a\/b|#x/)
  })

  test('a refused page carries its host and why it was turned away', async () => {
    const { seen, outcome } = await runCap('web.fetch', { url: 'https://shop.example.com/walled/cart?s=SECRET' })
    expect(outcome).toBe('failed')
    expect(seen[0]!.attributes).toEqual({
      'agw.web.host': 'shop.example.com',
      'agw.web.leg': undefined,
      'agw.web.cached': undefined,
      'agw.web.blocked': 'cloudflare-challenge',
    })
    expect(JSON.stringify(seen)).not.toMatch(/SECRET|walled|cart/)
  })

  test('another capability is left alone', async () => {
    const { seen } = await runCap('web.search', { query: 'x' })
    expect(seen).toEqual([])
  })
})
