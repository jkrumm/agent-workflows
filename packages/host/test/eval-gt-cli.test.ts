import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildCommands } from '../../cli/src/spec.ts'
import { createEvalGtWorkflows } from '../src/workflows/eval-gt/index.ts'
import { hostModules } from '../src/workflows/index.ts'
import { startTestHost, type TestHost } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'evalgt', extra: createEvalGtWorkflows({ env: {} }) })
})
afterAll(async () => {
  await t.close()
})

describe('agw eval gt', () => {
  test('pack and ingest are commands with their flags; nothing skipped', async () => {
    const { commands, skipped } = buildCommands(await t.host.openapi())
    expect(skipped).toEqual([])
    const flags = (words: string) => {
      const command = commands.find((c) => c.words.join(' ') === words)
      if (!command) throw new Error(`no command ${words}`)
      return { x: command.x, flags: command.fields.map((f) => f.flag).sort() }
    }
    const pack = flags('eval gt pack')
    expect(pack.x).toMatchObject({ kind: 'workflow', mutating: false })
    expect(pack.flags).toEqual(['cases', 'eval-runs', 'pairs', 'rejected', 'seed'])
    const ingest = flags('eval gt ingest')
    expect(ingest.flags).toEqual(['labels'])
    expect(ingest.x).toMatchObject({ mutating: true })
  })

  test('the host serves them as a discovered module', async () => {
    expect((await hostModules()).map((m) => m.id)).toContain('eval-gt')
  })
})
