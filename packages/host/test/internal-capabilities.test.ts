import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflows } from '../src/workflows/index.ts'
import { ToolGate } from '../src/tool-gate/index.ts'
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

  test('can never be granted to an agent: the tool gate treats them as unknown', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agw-internal-gate-'))
    const gate = new ToolGate({ stateDir, call: async () => ({ ok: true }) })
    try {
      await createWorkflows({ registry: t.registry, toolGate: gate }, [])
      for (const id of INTERNAL) {
        expect(() => gate.open({ runId: 'r', stepId: 's', tools: { opus: id } })).toThrow(
          `tool grant refused: opus -> ${id} is not a capability of this host`,
        )
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
