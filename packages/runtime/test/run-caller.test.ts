import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import { freshSchema, inspector, testRuntime } from './support/pg.ts'

const db = freshSchema('caller')
const sql = inspector(db.schema)
afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})
const leaf = defineWorkflow({
  id: 'caller.leaf',
  version: 'v1',
  input: empty,
  output: z.object({}),
  run: async () => ({}),
})
const parent = defineWorkflow({
  id: 'caller.parent',
  version: 'v1',
  input: empty,
  output: z.object({}),
  async run(ctx) {
    await ctx.workflow('kids', leaf, [{}, {}])
    return {}
  },
})

describe('run caller and project', () => {
  test('stamped at start and inherited by every child run', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [parent, leaf] })
    await rt.open()
    try {
      const { runId } = await rt.start(
        parent,
        {},
        { purpose: 'prod', caller: 'claude-code', project: 'a-repo', workspace: 'work' },
      )
      await rt.wait(runId)
      const { rows } = await sql.pool.query(
        `select id, parent_id, caller, project, workspace from "${db.schema}".runs where root_id = $1 order by parent_id nulls first`,
        [runId],
      )
      expect(rows).toHaveLength(3)
      for (const row of rows) expect(row).toMatchObject({ caller: 'claude-code', project: 'a-repo', workspace: 'work' })
    } finally {
      await rt.close()
    }
  })

  test('a run started without them reads null: the host started it', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [leaf] })
    await rt.open()
    try {
      const { runId } = await rt.start(leaf, {}, { purpose: 'retro' })
      await rt.wait(runId)
      expect(await sql.run(runId)).toMatchObject({ caller: null, project: null, workspace: null })
    } finally {
      await rt.close()
    }
  })
})
