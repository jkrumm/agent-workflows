// The audio process's suites through the host's `agw eval run`: the host reads the audio modules' suites, starts and
// scores a case with the audio module's own scorer, and the audio runtime alone executes it. Two runtimes, one journal.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyWorkflow, Runtime } from '@agent-workflows/runtime'
import { testPlatform } from '../../middleware/test/support.ts'
import { captureLogger, freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'
import {
  type FakeGateway,
  fakeMedia,
  geminiAudio,
  silentLog,
  startFakeGateway,
  testDeps,
} from '../../audio/src/testing/index.ts'
import { createSpeechRoundtrip } from '../../audio/src/workflows/speech-roundtrip/index.ts'
import { SPEECH_SCORER_VERSION } from '../../audio/src/workflows/speech-roundtrip/scorer.ts'
import { wireEval, createEvalWorkflows } from '../src/workflows/eval/index.ts'
import {
  buildWorkflows,
  discoverForeignModules,
  foreignWorkflows,
  loadForeignTree,
  suitesOf,
} from '../src/workflows/registry.ts'
import { hostModules } from '../src/workflows/index.ts'

const AUDIO_DIR = join(import.meta.dir, '../../audio/src/workflows')
const SENTENCE = 'The quick brown fox jumps over the lazy dog near the old stone bridge.'

const db = freshSchema('evalforeign')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-evalforeign-'))

describe('the audio tree as the host reads it', () => {
  test('its suites join the eval enum and its workflows are foreign, with the audio module’s own scorer', async () => {
    const elsewhere = await discoverForeignModules(AUDIO_DIR)
    expect(elsewhere.map((m) => m.id)).toEqual(['podcast', 'speech-roundtrip'])
    expect(elsewhere.every((m) => m.elsewhere)).toBe(true)
    const foreign = foreignWorkflows(elsewhere)
    expect(foreign.map((w) => w.id)).toEqual(['podcast', 'speech-roundtrip'])
    expect(foreign.find((w) => w.id === 'speech-roundtrip')?.scorer?.version).toBe(SPEECH_SCORER_VERSION)
    const suites = suitesOf([...(await hostModules()), ...elsewhere])
    expect(suites.has('podcast') && suites.has('speech-roundtrip')).toBe(true)
  })

  test('building the host tree with them builds none of them and refuses an id the host also serves', async () => {
    const elsewhere = await discoverForeignModules(AUDIO_DIR)
    const deps = {} as never
    const built = buildWorkflows(
      [{ id: 'eval-less', file: 'x', create: () => [], phase: undefined }, ...elsewhere],
      deps,
      () => true,
    )
    expect(built).toEqual([])
    const clash = {
      id: 'podcast',
      file: 'clash/module.ts',
      create: () => [{ workflow: foreignWorkflows(elsewhere)[0] as AnyWorkflow }],
    }
    expect(() => buildWorkflows([clash as never, ...elsewhere], deps, () => true)).toThrow('by clash/module.ts')
  })

  test('a missing tree is no foreign module', async () => {
    expect(await discoverForeignModules(join(root, 'nowhere'))).toEqual([])
  })
})

describe('agw eval run speech-roundtrip, on two runtimes', () => {
  let host: Runtime
  let audio: Runtime
  let iu: FakeGateway
  let hostPlatform: ReturnType<typeof testPlatform>
  let audioPlatform: ReturnType<typeof testPlatform>
  let wiring: ReturnType<typeof wireEval>
  let evalRun: AnyWorkflow
  let tts = 0
  let stt = 0

  beforeAll(async () => {
    const elsewhere = await discoverForeignModules(AUDIO_DIR)
    const foreign = foreignWorkflows(elsewhere)
    const evals = createEvalWorkflows(suitesOf([...(await hostModules()), ...elsewhere]), {
      env: { AGW_DRIFT_RATE: '0' },
    })
    evalRun = evals[0]?.workflow as AnyWorkflow

    iu = startFakeGateway({
      gemini: () => {
        tts++
        return geminiAudio(new Uint8Array(48_000))
      },
      transcriptions: () => {
        stt++
        return Response.json({ text: SENTENCE })
      },
    })
    const entry = createSpeechRoundtrip({
      audio: testDeps(iu, {
        log: silentLog,
        media: { ...fakeMedia, duration: async () => 4.5, compressForStt: async (b) => b.slice().buffer },
      }),
      artifactRoot: root,
    })

    hostPlatform = testPlatform(db.schema)
    audioPlatform = testPlatform(db.schema)
    host = testRuntime({
      schema: db.schema,
      workflows: evals.map((e) => e.workflow),
      foreign,
      middleware: hostPlatform.middleware,
    })
    audio = testRuntime({ schema: db.schema, workflows: [entry.workflow], middleware: audioPlatform.middleware })
    wiring = wireEval({ runtime: host, workflows: [...evals], foreign, env: { AGW_DRIFT_RATE: '0' } })
    await host.open()
    await audio.open()
    wiring.start()
  })

  afterAll(async () => {
    await wiring.close()
    await host.close()
    await audio.close()
    await hostPlatform.close()
    await audioPlatform.close()
    iu.stop()
    await sql.close()
    await db.drop()
    rmSync(root, { recursive: true, force: true })
  })

  // oxlint-disable-next-line typescript/no-explicit-any -- outputs are asserted field by field
  type Out = Record<string, any>
  async function evalOnce(input: Record<string, unknown>): Promise<Out> {
    const { runId } = await host.start(evalRun, input, { purpose: 'eval' })
    const end = await host.wait(runId)
    expect(end.error).toBeNull()
    return end.output as Out
  }

  test('without --yes it lists the cases and estimates, and nothing runs', async () => {
    const out = await evalOnce({ workflow: 'speech-roundtrip' })
    expect(out).toMatchObject({ workflow: 'speech-roundtrip', ran: false, cases: [] })
    expect(out.plan.ids).toEqual(['rt-en-1', 'rt-en-2', 'rt-en-3', 'rt-de-1', 'rt-de-2', 'rt-de-3'])
    expect(out.plan.estimate).toMatchObject({ historyRuns: 0, meanCostUsd: null, totalUsd: null })
    expect(tts + stt).toBe(0)
    const podcast = await evalOnce({ workflow: 'podcast' })
    expect(podcast.plan.ids).toHaveLength(5)
  })

  test('with --yes the audio runtime runs the case, the host scores it with the audio module’s scorer', async () => {
    const out = await evalOnce({ workflow: 'speech-roundtrip', yes: true, ids: 'rt-en-1' })
    const [only] = out.cases
    expect(only).toMatchObject({ caseId: 'rt-en-1', status: 'scored', runStatus: 'done', pass: true })
    expect(only.scores).toMatchObject({ valid: 1, werOk: 1, pace: 1, recorded: 1, wer: 0 })
    expect(only.costUsd).toBeGreaterThan(0)

    // Driven once, by the audio runtime: the host's foreign body would have failed the run.
    expect([tts, stt]).toEqual([1, 1])
    expect(await sql.run(only.runId)).toMatchObject({
      workflow: 'speech-roundtrip',
      purpose: 'eval',
      status: 'done',
      drives: 1,
      score_source: 'regression',
      scores: { final: { scorer: SPEECH_SCORER_VERSION, source: 'regression' } },
    })
  })

  test('args reach the audio case: a swapped STT route is the one asked', async () => {
    const out = await evalOnce({
      workflow: 'speech-roundtrip',
      yes: true,
      ids: 'rt-de-1',
      args: { sttRoute: 'audio.stt.openai' },
    })
    expect(out.cases[0]).toMatchObject({ status: 'scored', runStatus: 'done' })
    const run = await host.getRun(out.cases[0].runId)
    const output = run?.output as { stt: { route: string } } | undefined
    expect(output?.stt.route).toBe('audio.stt.openai')
  })
})

const FIXTURES = join(import.meta.dir, 'fixtures/foreign')
const at = (...parts: string[]) => join(FIXTURES, ...parts)

describe('the audio tree can fail without taking the host with it', () => {
  test('an import error under a module is logged, naming the path, and yields no foreign workflow', async () => {
    const logger = captureLogger()
    const tree = await loadForeignTree(at('throws'), logger)
    expect(tree).toEqual({ modules: [], workflows: [] })
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toMatchObject({ level: 'error', meta: { dir: at('throws') } })
    expect(logger.lines[0]?.message).toContain(at('throws'))
    expect(String(logger.lines[0]?.meta?.error)).toContain('boom at import')
  })

  test('a missing directory is a warning naming the path, and no foreign workflow', async () => {
    const logger = captureLogger()
    expect(await loadForeignTree(at('nowhere'), logger)).toEqual({ modules: [], workflows: [] })
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toMatchObject({ level: 'warn', meta: { dir: at('nowhere') } })
  })

  test('a bad declaration is the same: logged, none loaded', async () => {
    const logger = captureLogger()
    expect((await loadForeignTree(at('no-foreign'), logger)).workflows).toEqual([])
    expect(logger.lines[0]).toMatchObject({ level: 'error' })
    expect(String(logger.lines[0]?.meta?.error)).toContain('lone/module.ts')
  })
})

describe('discovery of a foreign tree', () => {
  test('a module with a suite and no foreign() fails, naming the file', async () => {
    const error = await discoverForeignModules(at('no-foreign')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(String(error)).toContain(at('no-foreign', 'lone', 'module.ts'))
    expect(String(error)).toContain('declares a suite but no foreign()')
  })

  test('foreign() is called once: the module, the runtime list and the clash check hold the same objects', async () => {
    const tree = await loadForeignTree(at('ok'), captureLogger())
    const [module] = tree.modules
    expect(tree.workflows).toHaveLength(1)
    expect(module?.elsewhere?.[0]).toBe(tree.workflows[0])
    expect(foreignWorkflows(tree.modules)[0]).toBe(tree.workflows[0])
    expect(tree.workflows[0]?.scorer?.version).toBe('far-scorer-1')
  })

  test('two modules serving one foreign id fail, naming both files', async () => {
    const error = await discoverForeignModules(at('dup')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(String(error)).toContain(at('dup', 'a', 'module.ts'))
    expect(String(error)).toContain(at('dup', 'b', 'module.ts'))
  })

  test('a foreign id the host also names fails before any create() runs, naming both files', async () => {
    const tree = await loadForeignTree(at('ok'), captureLogger())
    const created: string[] = []
    const hosted = {
      id: 'far',
      file: '/host/far/module.ts',
      create: () => {
        created.push('far')
        return []
      },
    }
    const other = {
      id: 'zed',
      file: '/host/zed/module.ts',
      create: () => {
        created.push('zed')
        return []
      },
    }
    const error = (() => {
      try {
        buildWorkflows([other, hosted, ...tree.modules], {} as never, () => true)
        return null
      } catch (e) {
        return e
      }
    })()
    expect(created).toEqual([])
    expect(String(error)).toContain('/host/far/module.ts')
    expect(String(error)).toContain(at('ok', 'far', 'module.ts'))
  })
})

describe('a case run of a workflow another process serves', () => {
  async function rig(options: { audio: 'up' | 'down' | 'other-version'; notClaimedMs?: number }) {
    const own = freshSchema('evalforeign2')
    const gateway = startFakeGateway({
      gemini: () => geminiAudio(new Uint8Array(48_000)),
      transcriptions: () => Response.json({ text: SENTENCE }),
    })
    const elsewhere = await discoverForeignModules(AUDIO_DIR)
    const foreign = foreignWorkflows(elsewhere)
    const evals = createEvalWorkflows(suitesOf([...(await hostModules()), ...elsewhere]), {
      env: { AGW_DRIFT_RATE: '0' },
      notClaimedMs: options.notClaimedMs ?? 600_000,
    })
    const entry = createSpeechRoundtrip({
      audio: testDeps(gateway, {
        log: silentLog,
        media: { ...fakeMedia, duration: async () => 4.5, compressForStt: async (b) => b.slice().buffer },
      }),
      artifactRoot: root,
    })
    const served = options.audio === 'other-version' ? { ...entry.workflow, version: 'skewed-1' } : entry.workflow
    const hostPlatform = testPlatform(own.schema)
    const audioPlatform = testPlatform(own.schema)
    const host = testRuntime({
      schema: own.schema,
      workflows: evals.map((e) => e.workflow),
      foreign,
      middleware: hostPlatform.middleware,
    })
    const audio = testRuntime({ schema: own.schema, workflows: [served], middleware: audioPlatform.middleware })
    const wiring = wireEval({ runtime: host, workflows: [...evals], foreign, env: { AGW_DRIFT_RATE: '0' } })
    await host.open()
    if (options.audio !== 'down') await audio.open()
    wiring.start()
    const inspect = inspector(own.schema)
    return {
      async run() {
        const { runId } = await host.start(
          evals[0]?.workflow as AnyWorkflow,
          { workflow: 'speech-roundtrip', yes: true, ids: 'rt-en-1' },
          { purpose: 'eval' },
        )
        return (await host.wait(runId)).output as { cases: Record<string, unknown>[] }
      },
      inspect,
      async close() {
        await wiring.close()
        await host.close()
        if (options.audio !== 'down') await audio.close()
        await hostPlatform.close()
        await audioPlatform.close()
        gateway.stop()
        await inspect.close()
        await own.drop()
      },
    }
  }

  test('never claimed within the bound: that case is an error and the run is cancelled, not waited on for ever', async () => {
    const t = await rig({ audio: 'down', notClaimedMs: 700 })
    try {
      const started = Date.now()
      const out = await t.run()
      expect(Date.now() - started).toBeLessThan(15_000)
      const [only] = out.cases
      expect(only).toMatchObject({
        caseId: 'rt-en-1',
        status: 'error',
        reason: 'not claimed: is the audio process up?',
      })
      expect(await t.inspect.run(only?.runId as string)).toMatchObject({ status: 'cancelled', drives: 0 })
    } finally {
      await t.close()
    }
  })

  test('a run the audio runtime finished under another version is an error, not scored', async () => {
    const t = await rig({ audio: 'other-version' })
    try {
      const out = await t.run()
      const [only] = out.cases
      expect(only).toMatchObject({ status: 'error', runStatus: 'done' })
      expect(String(only?.reason)).toBe(`version skew: run skewed-1 vs scorer ${SPEECH_SCORER_VERSION}`)
      expect((await t.inspect.run(only?.runId as string))?.scored_at ?? null).toBeNull()
    } finally {
      await t.close()
    }
  })

  test('a claimed run keeps the normal wait and is scored when the versions agree', async () => {
    const t = await rig({ audio: 'up', notClaimedMs: 700 })
    try {
      const [only] = (await t.run()).cases
      expect(only).toMatchObject({ status: 'scored', runStatus: 'done', pass: true })
    } finally {
      await t.close()
    }
  })
})
