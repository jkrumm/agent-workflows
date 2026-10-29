import { expect, test } from 'bun:test'
import { buildCommands } from '../../../cli/src/spec.ts'
import { createRegistry } from '../registry.ts'
import { createImageCapabilities } from './index.ts'

test('image.generate and image.cutout are hidden from the CLI (their answer is base64); image.enhance is a command', async () => {
  const registry = createRegistry(createImageCapabilities({ env: {} }))
  const { commands, skipped, hidden } = buildCommands(await registry.openapi())
  expect(commands.map((c) => c.words.join(' '))).toEqual(['image-enhance'])
  // hidden is not skipped: nothing was unusable about them
  expect(skipped).toEqual([])
  // ... and `agw schema` says they are hidden, with the command they would have had
  expect(hidden.map((h) => `${h.operation} ${h.command}`).sort()).toEqual([
    'POST /image/cutout image-cutout',
    'POST /image/generate image-generate',
  ])
  // still reachable over HTTP and in process
  expect(registry.ids().sort()).toEqual(['image.cutout', 'image.enhance', 'image.generate'])
})
