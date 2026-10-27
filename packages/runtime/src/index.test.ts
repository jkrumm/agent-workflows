import { expect, test } from 'bun:test'
import { RUNTIME_PACKAGE } from './index.ts'

test('runtime package exports its name', () => {
  expect(RUNTIME_PACKAGE).toBe('@agent-workflows/runtime')
})
