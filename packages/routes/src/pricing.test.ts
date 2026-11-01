import { expect, test } from 'bun:test'
import { join } from 'node:path'
import * as index from './index.ts'
import * as pricing from './pricing.ts'

test('the index re-exports the leaf: one definition of each', () => {
  expect(index.claudeRate).toBe(pricing.claudeRate)
  expect(index.resolveModelAlias).toBe(pricing.resolveModelAlias)
  expect(index.CLAUDE_MODELS).toBe(pricing.CLAUDE_MODELS)
  expect(index.costFromUsage).toBe(pricing.costFromUsage)
  expect(index.isBalanceFailure).toBe(pricing.isBalanceFailure)
})

test('the leaf bundles without the route table', async () => {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'pricing.ts')], target: 'bun' })
  expect(build.success).toBe(true)
  const text = await build.outputs[0]?.text()
  expect(text).toContain('claudeRate')
  expect(text).not.toContain('discoverRoutes')
  expect(text).not.toContain('Bun.Glob')
})
