import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestHost, type TestHost } from './support.ts'

// `prose.write` and `narrative.compose` are metered seats whose guards (lint, review, the keep gate) live in their
// workflows: a door caller must not reach them bare.

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'internalcap' })
})
afterAll(() => t.close())

const INTERNAL = ['prose.write', 'narrative.compose']

describe('internal capabilities at the host door', () => {
  test('stay callable in process, through the registry a workflow step uses', () => {
    for (const id of INTERNAL) expect(t.registry.ids()).toContain(id as never)
  })

  test('have no HTTP route, with the right bearer', async () => {
    for (const path of ['/prose/write', '/narrative/compose']) {
      const response = await t.call(path, { body: {} })
      expect(response.status).toBe(404)
    }
    // The served neighbour is still there (an invalid body is a 400, not a 404).
    expect((await t.call('/prose/critique', { body: {} })).status).toBe(400)
  })

  test('are not in the OpenAPI document, so the CLI generates no command, and have no `cap.<id>` run', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { operationId: string; 'x-cli': { command: string[] } }>>
    }
    const paths = Object.keys(doc.paths)
    expect(paths).toContain('/prose/critique')
    expect(paths).not.toContain('/prose/write')
    expect(paths).not.toContain('/narrative/compose')
    const commands = Object.values(doc.paths).flatMap((item) =>
      Object.values(item).map((op) => op['x-cli'].command.join(' ')),
    )
    expect(commands).not.toContain('prose-write')
    expect(commands).not.toContain('narrative-compose')
    expect(JSON.stringify(doc)).not.toMatch(/proseWrite|narrativeCompose/)
  })
})
