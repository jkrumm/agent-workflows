// A foreign workflow is served by another process: this runtime starts a run of it and scores it with its scorer, and
// never claims, leases, recovers or drives it. Two runtimes on one journal, as the host and the audio process are.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Scorer } from '../src/index.ts'
import { freshSchema, inspector, testRuntime, until } from '@agent-workflows/testing/pg'

const db = freshSchema('foreign')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const Input = z.object({ n: z.number() })
const Output = z.object({ doubled: z.number() })
const scorer: Scorer<{ n: number }, { want: number }> = {
  version: 'audio-scorer-v7',
  reference: z.object({ want: z.number() }),
  score: (_input, output, ctx) => {
    const got = (output as { doubled: number } | null)?.doubled
    return { scores: { exact: got === ctx.reference?.want ? 1 : 0 }, pass: got === ctx.reference?.want }
  },
}

const bodies: string[] = []
/** What the serving process has: the real body. */
const served = defineWorkflow({
  id: 'far.double',
  version: 'v1',
  input: Input,
  output: Output,
  scorer,
  async run(ctx, input) {
    await ctx.step('work', () => {
      bodies.push(ctx.runId)
      return null
    })
    return { doubled: input.n * 2 }
  },
})

/** What the other process knows of it: the same shape and scorer, a body that must never run. */
const foreign = defineWorkflow({
  id: 'far.double',
  version: 'v1',
  input: Input,
  output: Output,
  scorer,
  async run() {
    throw new Error('a foreign body ran')
  },
})

describe('foreign workflows', () => {
  test('are started and scored by the runtime that knows them, and driven only by the one that serves them', async () => {
    const near = testRuntime({ schema: db.schema, workflows: [], foreign: [foreign] })
    const far = testRuntime({ schema: db.schema, workflows: [served] })
    await near.open()
    try {
      const { runId } = await near.start(foreign, { n: 4 }, { purpose: 'prod' })
      // The serving process is down: nothing here takes the run, however often this runtime recovers.
      for (let i = 0; i < 5; i++) await near.recover()
      await Bun.sleep(300)
      const waiting = await sql.run(runId)
      expect(waiting).toMatchObject({ status: 'pending', drives: 0, workflow: 'far.double', version_started: 'v1' })
      expect(bodies).toEqual([])
      expect(await near.driftCandidates({ rate: 1, since: new Date(0), limit: 10 })).toEqual([])

      await far.open()
      try {
        const end = await near.wait(runId, { pollMs: 20 })
        expect(end).toMatchObject({ status: 'done', output: { doubled: 8 } })
        expect(bodies).toEqual([runId])
        expect(await sql.run(runId)).toMatchObject({ drives: 1 })
        expect(await far.driftCandidates({ rate: 1, since: new Date(0), limit: 10 })).toContain(runId)

        // Scored by the near runtime with the scorer it was given, at that scorer's version.
        const final = await near.scoreRun(runId, { source: 'regression', reference: { want: 8 } })
        expect(final).toMatchObject({ pass: true, scores: { exact: 1 }, scorer: 'audio-scorer-v7' })
        await until(async () => (await sql.run(runId))?.scored_at != null, 'the verdict is on the run')
      } finally {
        await far.close()
      }
    } finally {
      await near.close()
    }
  })

  test('a foreign id is not a hosted one: both lists, or another object under the id, are refused', async () => {
    expect(() => testRuntime({ schema: db.schema, workflows: [served], foreign: [foreign] })).toThrow(
      'registered twice',
    )
    const near = testRuntime({ schema: db.schema, workflows: [], foreign: [foreign] })
    try {
      const error = await near.start(served, { n: 1 }, { purpose: 'prod' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(error)).toContain('registered twice')
    } finally {
      await near.close()
    }
  })

  test('a started run keeps its input validated by the foreign shape', async () => {
    const near = testRuntime({ schema: db.schema, workflows: [], foreign: [foreign] })
    try {
      const error = await near.start(foreign, { n: 'x' } as never, { purpose: 'prod' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(error)).toContain('far.double')
    } finally {
      await near.close()
    }
  })
})
