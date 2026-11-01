import { expect, test } from 'bun:test'
import { CLAUDE_MODELS, claudeRate, resolveModelAlias } from '@agent-workflows/routes'
import { claudeRate as gatewayRate, resolveModelAlias as gatewayAlias } from '../src/routes.ts'

const ids = [...Object.values(CLAUDE_MODELS), 'haiku', 'sonnet', 'opus', 'constructor', 'no-such-model']

test.each(ids)('%s resolves and prices as in the routes package', (id) => {
  expect(gatewayAlias(id)).toBe(resolveModelAlias(id))
  expect(gatewayRate(id)).toEqual(claudeRate(id) as never)
  expect(gatewayRate(`${id}-20260101`)).toEqual(claudeRate(`${id}-20260101`) as never)
})
