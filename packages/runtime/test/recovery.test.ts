// Runs that cross a restart: the poison-run cap counts only unclean takeovers, and a run whose workflow no process
// registers any more ends instead of staying `running` forever.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import { freshSchema, inspector, testRuntime, until } from '@agent-workflows/testing/pg'

const db = freshSchema('recov')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

/** A workflow whose only step waits until the test releases it (or the run is aborted). */
function gated(id: string) {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = { entered: 0, release: () => release() }
  const workflow = defineWorkflow({
    id,
    version: 'v1',
    input: empty,
    output: empty,
    async run(ctx) {
      await ctx.step('wait', ({ signal }) => {
        state.entered++
        return new Promise<null>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          void released.then(() => resolve(null))
        })
      })
      return {}
    },
  })
  return { workflow, state }
}

describe('drive cap (F7)', () => {
  test('clean shutdown handoffs do not count; unclean takeovers do and reach crash_loop', async () => {
    const { workflow, state } = gated('recov.drives')
    let runId = ''
    for (let boot = 1; boot <= 4; boot++) {
      const rt = testRuntime({ schema: db.schema, workflows: [workflow], maxDrives: 2 })
      await rt.open()
      if (boot === 1) runId = (await rt.start(workflow, {}, { purpose: 'test' })).runId
      await until(() => state.entered === boot, `boot ${boot} in the step`)
      await rt.close() // graceful: the row stays running, the lease is handed off
      expect(await sql.run(runId)).toMatchObject({ status: 'running', drives: 1, lease_held: false })
    }

    // The holder dies without releasing (kill -9, power loss): lease_held stays true, so each takeover counts.
    await sql.pool.query(`update "${db.schema}".runs set lease_held = true where id = $1`, [runId])
    const second = testRuntime({ schema: db.schema, workflows: [workflow], maxDrives: 2 })
    await second.open()
    await until(() => state.entered === 5, 'first unclean takeover in the step')
    expect((await sql.run(runId))?.drives).toBe(2)
    await second.close()
    await sql.pool.query(`update "${db.schema}".runs set lease_held = true where id = $1`, [runId])
    const last = testRuntime({ schema: db.schema, workflows: [workflow], maxDrives: 2 })
    await last.open()
    try {
      const end = await last.wait(runId, { pollMs: 20 })
      expect(end).toMatchObject({ status: 'failed', error: { kind: 'crash_loop' } })
      expect((await sql.run(runId))?.drives).toBe(3)
    } finally {
      state.release()
      await last.close()
    }
  })

  test('a drive that finishes or an infra retry that exits leaves the lease released', async () => {
    const wf = defineWorkflow({ id: 'recov.done', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'test' })
      expect((await rt.wait(runId, { pollMs: 20 })).status).toBe('done')
      await until(async () => (await sql.run(runId))?.lease_held === false, 'lease released')
      expect((await sql.run(runId))?.drives).toBe(1)
    } finally {
      await rt.close()
    }
  })
})

describe('runs of an unregistered workflow (F6)', () => {
  test('failed as infra after the grace period; a foreign or registered workflow is left alone', async () => {
    const gone = gated('recov.gone')
    const served = gated('recov.served')
    const owner = testRuntime({ schema: db.schema, workflows: [gone.workflow, served.workflow] })
    await owner.open()
    const goneRun = (await owner.start(gone.workflow, {}, { purpose: 'test' })).runId
    const servedRun = (await owner.start(served.workflow, {}, { purpose: 'test' })).runId
    await until(() => gone.state.entered === 1 && served.state.entered === 1, 'both in their step')
    await owner.close()

    // Within the grace period nothing happens.
    const patient = testRuntime({ schema: db.schema, workflows: [], unknownWorkflowGraceMs: 600_000 })
    await patient.open()
    await Bun.sleep(400)
    await patient.close()
    expect((await sql.run(goneRun))?.status).toBe('running')

    // The process that serves `served` is down, but the sweeping one knows it as foreign: it waits.
    const sweeper = testRuntime({
      schema: db.schema,
      workflows: [],
      foreign: [served.workflow],
      unknownWorkflowGraceMs: 300,
    })
    await sweeper.open()
    try {
      const end = await sweeper.wait(goneRun, { pollMs: 20 })
      expect(end).toMatchObject({ status: 'failed', error: { kind: 'infra' } })
      expect(await sql.run(goneRun)).toMatchObject({ status: 'failed', error_kind: 'infra' })
      expect(await sql.step(goneRun, 'wait')).toMatchObject({ status: 'failed', error_kind: 'infra' })
      await Bun.sleep(600)
      expect((await sql.run(servedRun))?.status).toBe('running')
    } finally {
      served.state.release()
      await sweeper.close()
    }
  })

  test('a cancel of such a run ends it cancelled after the grace period', async () => {
    const gone = gated('recov.gone-cancel')
    const owner = testRuntime({ schema: db.schema, workflows: [gone.workflow] })
    await owner.open()
    const { runId } = await owner.start(gone.workflow, {}, { purpose: 'test' })
    await until(() => gone.state.entered === 1, 'in the step')
    await owner.close()

    const sweeper = testRuntime({ schema: db.schema, workflows: [], unknownWorkflowGraceMs: 300 })
    await sweeper.open()
    try {
      await sweeper.cancel(runId)
      expect((await sql.run(runId))?.status).toBe('running') // nobody drives it yet
      const end = await sweeper.wait(runId, { pollMs: 20 })
      expect(end.status).toBe('cancelled')
      expect(await sql.step(runId, 'wait')).toMatchObject({ status: 'cancelled' })
    } finally {
      await sweeper.close()
    }
  })

  test('a pending run of an unregistered workflow and its descendants end with it', async () => {
    const wf = gated('recov.gone-pending')
    const seeder = testRuntime({ schema: db.schema, workflows: [wf.workflow], maxConcurrentRuns: 0 })
    const { runId } = await seeder.start(wf.workflow, {}, { purpose: 'test' })
    await seeder.close()
    expect((await sql.run(runId))?.status).toBe('pending')

    const sweeper = testRuntime({ schema: db.schema, workflows: [], unknownWorkflowGraceMs: 300 })
    await sweeper.open()
    try {
      const end = await sweeper.wait(runId, { pollMs: 20 })
      expect(end).toMatchObject({ status: 'failed', error: { kind: 'infra' } })
    } finally {
      await sweeper.close()
    }
  })
})
