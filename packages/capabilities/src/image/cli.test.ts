import { expect, test } from 'bun:test'
import { buildCommands } from '../../../cli/src/spec.ts'
import { createRegistry } from '../registry.ts'
import { createImageCapabilities } from './index.ts'

test('image.generate and image.cutout are not CLI commands (their answer is base64); image.enhance is', async () => {
  const registry = createRegistry(createImageCapabilities({ env: {} }))
  const { commands, skipped } = buildCommands(await registry.openapi())
  expect(commands.map((c) => c.words.join(' '))).toEqual(['image enhance'])
  expect(skipped.map((s) => s.operation).sort()).toEqual(['POST /image/cutout', 'POST /image/generate'])
  // still reachable over HTTP and in process
  expect(registry.ids().sort()).toEqual(['image.cutout', 'image.enhance', 'image.generate'])
})
