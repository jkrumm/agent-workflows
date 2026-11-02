import { describe, expect, test } from 'bun:test'
import { RouteOverrideError, resolveRoute, routeSchema, validateArm } from './index.ts'
import { discoverRoutes } from './registry.ts'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const sonnet = { wire: 'anthropic', model: 'claude-sonnet-5-5', effort: 'none' } as const

describe('Sonnet at effort none is a configuration error', () => {
  test('the route schema refuses it, by prefix and by alias; other families and efforts pass', () => {
    expect(routeSchema.safeParse(sonnet).success).toBe(false)
    expect(routeSchema.safeParse({ ...sonnet, model: 'sonnet' }).success).toBe(false)
    expect(routeSchema.safeParse({ ...sonnet, effort: 'low' }).success).toBe(true)
    expect(routeSchema.safeParse({ ...sonnet, effort: undefined }).success).toBe(true)
    expect(routeSchema.safeParse({ ...sonnet, model: 'claude-haiku-5-5' }).success).toBe(true)
    expect(routeSchema.safeParse({ ...sonnet, model: 'claude-opus-5-5' }).success).toBe(true)
  })

  test('every id form of a Sonnet is refused at none: concrete, alias, dated snapshot, long-context flag', () => {
    for (const model of ['claude-sonnet-5-5', 'sonnet', 'claude-sonnet-5-5-20261001', 'claude-sonnet-5-5[1m]']) {
      expect(routeSchema.safeParse({ ...sonnet, model }).success, model).toBe(false)
      expect(routeSchema.safeParse({ ...sonnet, model, effort: 'medium' }).success, model).toBe(true)
    }
  })

  test('other families, and names that only contain sonnet, are not Sonnets', () => {
    for (const model of ['claude-haiku-5-5', 'claude-opus-5-5', 'haiku', 'gpt-6-luna', 'my-sonnet-fork']) {
      expect(routeSchema.safeParse({ ...sonnet, model }).success, model).toBe(true)
    }
  })

  test('a fallback is checked too', () => {
    expect(
      routeSchema.safeParse({ wire: 'anthropic', model: 'm', fallback: { ...sonnet, wire: 'iu-openai' } }).success,
    ).toBe(false)
  })

  test('the table import names the route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-sonnet-'))
    writeFileSync(
      join(dir, 'x.ts'),
      "export default { 'x.sonnet': { wire: 'anthropic', model: 'claude-sonnet-5-5', effort: 'none' } }\n",
    )
    const error = await discoverRoutes(dir).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(String(error)).toMatch(/"x\.sonnet" is invalid.*Sonnet.*effort none/s)
  })

  test('a patch naming a Sonnet model or effort none is refused, naming the route', () => {
    const onHaikuRoute = { 'cheap.classify': { model: 'claude-sonnet-5-5' } }
    // cheap.classify runs Haiku at effort none: moving it to a Sonnet without raising the effort is the error.
    expect(() => validateArm({ routes: onHaikuRoute })).toThrow(RouteOverrideError)
    expect(() => resolveRoute('cheap.classify', onHaikuRoute)).toThrow(/cheap\.classify.*Sonnet.*effort none/s)
    expect(() => resolveRoute('review.angle', { 'review.angle': { effort: 'none' } })).toThrow(/review\.angle.*Sonnet/s)
  })

  test('the same patch with a real effort is accepted', () => {
    const patch = { 'cheap.classify': { model: 'claude-sonnet-5-5', effort: 'low' } }
    expect(resolveRoute('cheap.classify', patch)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
  })
})
