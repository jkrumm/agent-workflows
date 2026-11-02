import { expect, test } from 'bun:test'
import { basename, join } from 'node:path'
import { DEFAULT_ROUTES } from './index.ts'
import { ROUTE_GROUPS, routeRate } from './rates.ts'

test('every route group of src/table/ is in the static list', () => {
  const files = [...new Bun.Glob('*.ts').scanSync({ cwd: join(import.meta.dir, 'table') })]
    .filter((file) => file !== '_shared.ts' && !file.endsWith('.test.ts'))
    .map((file) => basename(file, '.ts'))
    .sort()
  expect(Object.keys(ROUTE_GROUPS).sort()).toEqual(files)
})

test('one rate per model: every route and fallback with a rate gets it back', () => {
  let rated = 0
  for (const [id, route] of Object.entries(DEFAULT_ROUTES)) {
    for (const entry of [route, route.fallback]) {
      if (!entry?.rate) continue
      rated++
      expect({ id, model: entry.model, rate: routeRate(entry.model) }).toEqual({
        id,
        model: entry.model,
        rate: entry.rate,
      })
    }
  }
  expect(rated).toBeGreaterThan(0)
})

test('the IU text models carry their route rate', () => {
  expect(routeRate('gpt-6.1-terra')).toMatchObject({ inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.05 })
  expect(routeRate('gemini-3.8-flash')).toMatchObject({ inputPerM: 0.75, outputPerM: 3.75 })
})

test('a model without a rate, or not in the table, has none', () => {
  expect(routeRate('gpt-image-2.5-flare')).toBeNull()
  expect(routeRate('openai.gpt-6.1-terra')).toBeNull()
  expect(routeRate('no-such-model')).toBeNull()
  expect(routeRate('toString')).toBeNull()
})

test('the leaf bundles without the route discovery', async () => {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'rates.ts')], target: 'bun' })
  expect(build.success).toBe(true)
  const text = await build.outputs[0]?.text()
  expect(text).toContain('routeRate')
  expect(text).not.toContain('discoverRoutes')
  expect(text).not.toContain('Bun.Glob')
})
