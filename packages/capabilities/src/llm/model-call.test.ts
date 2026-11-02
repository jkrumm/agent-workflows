import { describe, expect, test } from 'bun:test'
import { canonicalModel, DEFAULT_ROUTES, resolveRoute } from '@agent-workflows/routes'
import { toUsage } from './model-call.ts'

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
