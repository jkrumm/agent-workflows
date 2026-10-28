import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildCommands, type Document } from '../../cli/src/spec.ts'
import { createEvalWorkflows } from '../src/workflows/eval/index.ts'
import { startTestHost, type TestHost } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'evalcli', extra: createEvalWorkflows() })
})
afterAll(async () => {
  await t.close()
})

describe('agw eval in the generated CLI', () => {
  test('eval run and eval compare are commands with their flags; nothing skipped', async () => {
    const { commands, skipped } = buildCommands((await t.host.openapi()) as unknown as Document)
    expect(skipped).toEqual([])
    const flags = (words: string) => {
      const command = commands.find((c) => c.words.join(' ') === words)
      if (!command) throw new Error(`no command ${words}`)
      return { x: command.x, flags: command.fields.map((f) => f.flag).sort() }
    }
    const run = flags('eval run')
    expect(run.x).toMatchObject({ kind: 'workflow', positional: ['workflow'], mutating: false })
    expect(run.flags).toEqual(['args', 'concurrency', 'ids', 'limit', 'workflow', 'yes'])
    const compare = flags('eval compare')
    expect(compare.x).toMatchObject({ kind: 'workflow', positional: ['workflow'] })
    expect(compare.flags).toEqual(['a', 'a-args', 'b', 'b-args', 'seed', 'workflow'])
  })
})
