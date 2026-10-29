import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '../../../../capabilities/src/index.ts'
import { fakeTransports } from '../../../../capabilities/src/testing/index.ts'
import { ToolGate } from '../../../../host/src/tool-gate/index.ts'
import { buildWorkflows, discoverWorkflowModules } from '../../../../host/src/workflows/registry.ts'
import { testConfig } from '../../testing/index.ts'
import type { ProduceModuleDeps } from './module.ts'

// The audio process's tree as the host's registry builds it: `podcast.produce` internal, `podcast-publish` a command,
// and the room (a `last`-phase module) handed `podcast.produce` as a peer.

const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
const toolGate = new ToolGate({ stateDir: '/nonexistent/agw-produce-module', call: async () => null })
const journal = { db: { query: async () => ({ rows: [] }) }, schema: 'agw' }

describe('podcast-produce module', () => {
  test('registers the internal child and the public follow-up; the room finds the child among its peers', async () => {
    const modules = await discoverWorkflowModules(join(import.meta.dir, '..'))
    const deps: ProduceModuleDeps = {
      registry,
      toolGate,
      journal,
      audio: { config: testConfig('https://iu.example.com/anthropic'), env: {} },
    }
    const built = buildWorkflows(modules, deps, () => true)
    const byId = new Map(built.map((entry) => [entry.workflow.id, entry]))
    expect(byId.get('podcast.produce')?.internal).toBe(true)
    expect(byId.get('podcast-publish')?.internal).toBeUndefined()
    expect(byId.get('podcast-publish')?.cli).toMatchObject({ positional: ['runId'], mutating: true })
    expect(byId.has('podcast')).toBe(true)
  })

  test('fails at build without the journal', async () => {
    const { default: module } = await import('./module.ts')
    expect(() => module.create({ registry, toolGate }, { peers: [], suites: [] } as never)).toThrow('journal')
  })
})
