import { describe, expect, test } from 'bun:test'
import { canonicalModel, DEFAULT_ROUTES, resolveRoute } from '@agent-workflows/routes'
import type { Usage } from '../context.ts'
import type { AttemptUsage, ChatPort, ChatResult, GatewayTransports } from '../transports/port.ts'
import { complete, toUsage } from './model-call.ts'

const tokens = { input: 10, output: 2, cacheRead: 0, reasoning: 0 }

describe('toUsage', () => {
  const route = resolveRoute('cheap.classify', {})
  const textRoute = resolveRoute(
    Object.keys(DEFAULT_ROUTES).find(
      (id) => DEFAULT_ROUTES[id as keyof typeof DEFAULT_ROUTES].wire === 'iu-openai',
    ) as never,
    {},
  )

  test('the model is canonical whatever the provider echoed, so one model is one byModel key', () => {
    const echoes = [
      `openai.${textRoute.model}`,
      `vertex_ai_eu/${textRoute.model}`,
      `deepseek/${textRoute.model}`,
      textRoute.model,
    ]
    const keys = new Set(echoes.map((model) => toUsage(textRoute, textRoute.model, { model, tokens, cost: 0.1 }).model))
    expect([...keys]).toEqual([textRoute.model])
  })

  test('a Claude snapshot or [1m] echo is the table id', () => {
    for (const model of [`${route.model}-20261001`, `${route.model}[1m]`, `${route.model}-20261001[1m]`]) {
      expect(toUsage(route, route.model, { model, tokens, cost: null }).model).toBe(canonicalModel(route.model))
    }
  })

  test('a call the provider returned no usage for is canonical too; an unknown echo stays as it is', () => {
    expect(toUsage(textRoute, `openai.${textRoute.model}`, undefined).model).toBe(textRoute.model)
    expect(toUsage(textRoute, 'some-unknown-model', undefined).model).toBe('some-unknown-model')
  })

  test('the route id is on the usage; a fallback call keeps the primary’s', () => {
    expect(toUsage(route, route.model, undefined).route).toBe('cheap.classify')
    const fallback = { ...textRoute, isFallback: true as const }
    expect(toUsage(fallback, fallback.model, undefined).route).toBe(textRoute.id)
  })
})

describe('complete: usage of an attempt that throws', () => {
  const routeId = Object.keys(DEFAULT_ROUTES).find((id) => {
    const route = DEFAULT_ROUTES[id as keyof typeof DEFAULT_ROUTES]
    return route.wire === 'iu-openai' && !('fallback' in route && route.fallback)
  }) as never
  const attempt = (model: string): AttemptUsage => ({ model, tokens, cost: 0.25 })
  const answer = (model: string): ChatResult => ({ text: 'ok', stop: 'complete', model })

  /** `complete` over a port that behaves as `run` says; returns every usage reported and how the call ended. */
  async function call(run: (onUsage: (usage: AttemptUsage) => void, model: string) => Promise<ChatResult>) {
    const reported: Usage[] = []
    const port: ChatPort = { complete: (request, _signal, onUsage) => run(onUsage ?? (() => {}), request.model) }
    const deps = { transports: { openai: port, anthropic: port } as unknown as GatewayTransports, warn: () => {} }
    const ctx = { signal: new AbortController().signal, addUsage: (usage: Usage) => void reported.push(usage) }
    const outcome = await complete(deps, { routeId, prompt: 'p', ctx }).then(
      () => 'returned',
      (err: unknown) => err,
    )
    return { reported, outcome }
  }

  test('a call that bills and then throws reports the billed attempt once', async () => {
    const { reported, outcome } = await call(async (onUsage, model) => {
      onUsage(attempt(model))
      throw new Error('stream cut before the finish chunk')
    })
    expect(outcome).toBeInstanceOf(Error)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.tokens).toMatchObject({ input: 10, output: 2 })
    expect(reported[0]?.cost).toBe(0.25)
  })

  test('a call that throws with no usage known reports nothing: no tokens are invented', async () => {
    const { reported, outcome } = await call(async () => {
      throw new Error('connection refused')
    })
    expect(outcome).toBeInstanceOf(Error)
    expect(reported).toEqual([])
  })

  test('a success reports once, with its usage; a success with none reports one unknown call', async () => {
    const known = await call(async (onUsage, model) => {
      onUsage(attempt(model))
      return answer(model)
    })
    expect(known.outcome).toBe('returned')
    expect(known.reported).toHaveLength(1)
    expect(known.reported[0]?.cost).toBe(0.25)

    const unknown = await call(async (_onUsage, model) => answer(model))
    expect(unknown.reported).toHaveLength(1)
    expect(unknown.reported[0]?.tokens).toMatchObject({ input: 0, output: 0 })
  })
})
