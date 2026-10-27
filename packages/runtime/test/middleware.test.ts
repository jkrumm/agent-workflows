import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { AdmissionRefused, defineWorkflow, type Middleware, type RunPreArgs, type StepPreArgs } from '../src/index.ts'
import { captureLogger, freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('mw')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('middleware', () => {
  test('hooks run in list order around run and steps, with the run-record facts', async () => {
    const log: string[] = []
    const runPres: RunPreArgs[] = []
    const stepPres: StepPreArgs[] = []
    const tagged = (name: string): Middleware => ({
      name,
      runPre: (a) => {
        log.push(`${name}:runPre`)
        runPres.push(a)
      },
      stepPre: (a) => {
        log.push(`${name}:stepPre:${a.stepId}`)
        stepPres.push(a)
      },
      stepPost: (a) => void log.push(`${name}:stepPost:${a.stepId}:${a.status}`),
      runPost: (a) => void log.push(`${name}:runPost:${a.status}`),
    })
    const wf = defineWorkflow({
      id: 'mw.order',
      version: 'v7',
      input: z.object({ q: z.string() }),
      output: empty,
      async run(ctx) {
        await ctx.step('one', () => 1)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [tagged('a'), tagged('b')] })
    await rt.open()
    try {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const { runId } = await rt.start(wf, { q: 'hi' }, { purpose: 'eval', traceparent })
      await rt.wait(runId)
      await until(() => log.length === 8, 'all hooks')
      expect(log).toEqual([
        'a:runPre',
        'b:runPre',
        'a:stepPre:one',
        'b:stepPre:one',
        'a:stepPost:one:done',
        'b:stepPost:one:done',
        'a:runPost:done',
        'b:runPost:done',
      ])
      expect(runPres[0]).toEqual({
        runId,
        workflowId: 'mw.order',
        version: 'v7',
        purpose: 'eval',
        parentId: null,
        rootId: runId,
        input: { q: 'hi' },
        traceparent,
        resume: false,
      })
      expect(stepPres[0]).toMatchObject({
        runId,
        stepId: 'one',
        kind: 'code',
        status: 'running',
        attempt: 1,
        replay: false,
      })
    } finally {
      await rt.close()
    }
  })

  test('runPre gets resume and stepPre gets replay on a resumed run', async () => {
    const runPres: RunPreArgs[] = []
    const stepPres: StepPreArgs[] = []
    const mw: Middleware = {
      name: 'flags',
      runPre: (a) => void runPres.push(a),
      stepPre: (a) => void stepPres.push(a),
    }
    let calls = 0
    const wf = defineWorkflow({
      id: 'mw.resume',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('slow', async () => {
          calls++
          if (calls === 1) await Bun.sleep(5000)
          return null
        })
        return {}
      },
    })
    const first = testRuntime({ schema: db.schema, workflows: [wf], middleware: [mw] })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => calls === 1, 'first attempt')
    await first.close()
    const second = testRuntime({ schema: db.schema, workflows: [wf], middleware: [mw] })
    await second.open()
    try {
      expect((await second.wait(runId)).status).toBe('done')
      expect(runPres.map((a) => a.resume)).toEqual([false, true])
      expect(stepPres.map((a) => [a.replay, a.attempt])).toEqual([
        [false, 1],
        [true, 2],
      ])
    } finally {
      await second.close()
    }
  })

  test('AdmissionRefused in runPre fails a new run before its body runs', async () => {
    let ran = false
    const statuses: string[] = []
    const wallet: Middleware = {
      name: 'wallet',
      runPre: () => {
        throw new AdmissionRefused('wallet empty')
      },
      runPost: (a) => void statuses.push(a.status),
    }
    const wf = defineWorkflow({
      id: 'mw.refuse',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => {
        ran = true
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [wallet] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'prod' })
      const result = await rt.wait(runId)
      expect(result).toMatchObject({ status: 'failed', error: { kind: 'admission_refused', message: 'wallet empty' } })
      expect(ran).toBe(false)
      expect(statuses).toEqual(['failed'])
    } finally {
      await rt.close()
    }
  })

  test('AdmissionRefused on resume is logged and ignored', async () => {
    let refuse = false
    const gate: Middleware = {
      name: 'gate',
      runPre: () => {
        if (refuse) throw new AdmissionRefused('closed now')
      },
    }
    let calls = 0
    const wf = defineWorkflow({
      id: 'mw.refuse-resume',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('slow', async () => {
          calls++
          if (calls === 1) await Bun.sleep(5000)
          return null
        })
        return {}
      },
    })
    const first = testRuntime({ schema: db.schema, workflows: [wf], middleware: [gate] })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => calls === 1, 'first attempt')
    await first.close()
    refuse = true
    const logger = captureLogger()
    const second = testRuntime({ schema: db.schema, workflows: [wf], middleware: [gate], logger })
    await second.open()
    try {
      expect((await second.wait(runId)).status).toBe('done')
      expect(logger.lines.some((l) => l.message.includes('runPre threw on resume'))).toBe(true)
    } finally {
      await second.close()
    }
  })

  test('a throwing post-hook after done never downgrades the committed outcome', async () => {
    const throwing: Middleware = {
      name: 'broken-record',
      stepPost: () => {
        throw new Error('record sink down')
      },
      runPost: () => {
        throw new Error('record sink down')
      },
    }
    const wf = defineWorkflow({
      id: 'mw.post-throws',
      version: 'v1',
      input: empty,
      output: z.object({ n: z.number() }),
      async run(ctx) {
        return { n: await ctx.step('n', () => 1) }
      },
    })
    const logger = captureLogger()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [throwing], logger })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect(await rt.wait(runId)).toMatchObject({ status: 'done', output: { n: 1 } })
      expect(await sql.step(runId, 'n')).toMatchObject({ status: 'done' })
      await until(() => logger.lines.filter((l) => l.level === 'error').length === 2, 'both hook errors logged')
      await Bun.sleep(100)
      expect((await sql.run(runId))?.status).toBe('done')
    } finally {
      await rt.close()
    }
  })

  test('a throwing stepPre fails the step as middleware (runaway caps)', async () => {
    let ran = false
    const cap: Middleware = {
      name: 'cap',
      stepPre: (a) => {
        if (a.stepId === 'expensive') throw new Error('runaway cap')
      },
    }
    const wf = defineWorkflow({
      id: 'mw.cap',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('expensive', () => {
          ran = true
          return null
        })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [cap] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(ran).toBe(false)
      expect(await sql.step(runId, 'expensive')).toMatchObject({ status: 'failed', error_kind: 'middleware' })
    } finally {
      await rt.close()
    }
  })
})
