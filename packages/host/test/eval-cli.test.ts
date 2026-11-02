import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildCommands } from '../../cli/src/spec.ts'
import { createEvalWorkflows } from '../src/workflows/eval/index.ts'
import { hostModules, suitesOf } from '../src/workflows/index.ts'
import { startTestHost, type TestHost } from './support.ts'

const HOST_SUITES = suitesOf(await hostModules())

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'evalcli', extra: createEvalWorkflows(HOST_SUITES) })
})
afterAll(async () => {
  await t.close()
})

describe('agw eval in the generated CLI', () => {
  test('eval run, eval compare and eval import are commands with their flags; nothing skipped', async () => {
    const { commands, skipped } = buildCommands(await t.host.openapi())
    expect(skipped).toEqual([])
    const flags = (words: string) => {
      const command = commands.find((c) => c.words.join(' ') === words)
      if (!command) throw new Error(`no command ${words}`)
      return { x: command.x, flags: command.fields.map((f) => f.flag).sort() }
    }
    const run = flags('eval run')
    expect(run.x).toMatchObject({ kind: 'workflow', positional: ['workflow'], mutating: false })
    expect(run.flags).toEqual(['args', 'arm', 'concurrency', 'ids', 'limit', 'workflow', 'yes'])
    const compare = flags('eval compare')
    expect(compare.x).toMatchObject({ kind: 'workflow', positional: ['workflow'] })
    expect(compare.flags).toEqual(['a', 'a-args', 'a-workflow', 'b', 'b-args', 'b-workflow', 'seed', 'workflow'])
    const imported = flags('eval import')
    expect(imported.x).toMatchObject({ kind: 'workflow', positional: ['workflow'] })
    expect(imported.flags).toEqual(['concurrency', 'findings', 'ids', 'label', 'workflow', 'yes'])
    // The importer's own workflow is internal: no command of its own.
    expect(commands.find((c) => c.words.join(' ') === 'review imported')).toBeUndefined()
  })
})
