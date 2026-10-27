import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Middleware, type RunPostArgs, type StepPostArgs } from '../src/index.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('ctl')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

function recorder() {
  const runs: RunPostArgs[] = []
  const steps: StepPostArgs[] = []
  const mw: Middleware = {
    name: 'recorder',
    runPost: (a) => void runs.push(a),
    stepPost: (a) => void steps.push(a),
  }
  return { mw, runs, steps }
}

describe('cancel', () => {
  test('cancel during a code step aborts its signal; run and step end cancelled', async () => {
    let started = false
    let sawAbort = false
    let after = 0
    const wf = defineWorkflow({
      id: 'ctl.cancel-step',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('long', async ({ signal }) => {
          started = true
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => {
              sawAbort = true
              resolve()
            }),
          )
          return null
        })
        await ctx.step('after', () => ++after)
        return {}
      },
    })
    const rec = recorder()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [rec.mw] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => started, 'step start')
      expect(await rt.cancel(runId)).toBe(true)
      const result = await rt.wait(runId)
      expect(result.status).toBe('cancelled')
      expect(sawAbort).toBe(true)
      await until(async () => (await sql.step(runId, 'long'))?.status === 'cancelled', 'step cancelled')
      expect(after).toBe(0)
      await until(() => rec.runs.length === 1, 'runPost')
      expect(rec.runs[0]?.status).toBe('cancelled')
    } finally {
      await rt.close()
    }
  })

  test('a cancel from another process reaches the driving process and aborts the agent session', async () => {
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(10_000, 50)
      return { output: 'never' }
    })
    const wf = defineWorkflow({
      id: 'ctl.cancel-agent',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.agent('think', { agent: 'helper', prompt: 'long task' })
        return {}
      },
    })
    const driver = testRuntime({ schema: db.schema, workflows: [wf], host })
    const other = testRuntime({ schema: db.schema, workflows: [] })
    await driver.open()
    try {
      const { runId } = await driver.start(wf, {}, { purpose: 'build' })
      await until(() => host.count('prompt', 'sent') === 1, 'prompt')
      await other.cancel(runId)
      expect((await driver.wait(runId)).status).toBe('cancelled')
      await until(() => host.count('abort') === 1, 'host.abort')
      expect([...host.sessions.values()][0]?.aborted).toBe(true)
    } finally {
      await other.close()
      await driver.close()
    }
  })

  test('cancelling a pending run ends it without driving it', async () => {
    let ran = false
    const wf = defineWorkflow({
      id: 'ctl.cancel-pending',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => {
        ran = true
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    const { runId } = await rt.start(wf, {}, { purpose: 'build' }) // not opened: stays pending
    await rt.cancel(runId)
    expect((await rt.wait(runId)).status).toBe('cancelled')
    await rt.close()
    const later = testRuntime({ schema: db.schema, workflows: [wf] })
    await later.open()
    await later.recover()
    await later.close()
    expect(ran).toBe(false)
  })
})

describe('steer', () => {
  test('a steer is journaled and delivered to the running agent session', async () => {
    const host = new FakeAgentHost(async (s) => {
      const text = await s.nextSteer()
      return { output: { steered: text } }
    })
    const wf = defineWorkflow({
      id: 'ctl.steer',
      version: 'v1',
      input: empty,
      output: z.object({ steered: z.string() }),
      run: (ctx) =>
        ctx.agent('ask', { agent: 'helper', prompt: 'wait for a nudge', output: z.object({ steered: z.string() }) }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    const remote = testRuntime({ schema: db.schema, workflows: [] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => host.count('prompt', 'sent') === 1, 'prompt')
      await until(async () => (await sql.step(runId, 'ask'))?.status === 'running', 'step running')
      await remote.steer(runId, 'ask', 'focus on tests')
      expect((await rt.wait(runId)).output).toEqual({ steered: 'focus on tests' })
      const { rows } = await sql.pool.query(
        `select payload, delivered_at from "${db.schema}".signals where run_id = $1`,
        [runId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].payload).toEqual({ text: 'focus on tests' })
      expect(rows[0].delivered_at).toBeInstanceOf(Date)
      const late = await remote.steer(runId, 'ask', 'too late').catch((err: unknown) => err)
      expect(String(late)).toContain('not a running agent step')
    } finally {
      await remote.close()
      await rt.close()
    }
  })
})
