// The audio process's suites through the host's `agw eval run`: the host reads the audio modules' suites, starts and
// scores a case with the audio module's own scorer, and the audio runtime alone executes it. Two runtimes, one journal.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyWorkflow, Runtime } from '@agent-workflows/runtime'
import { testPlatform } from '../../middleware/test/support.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'
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
import { buildWorkflows, discoverForeignModules, foreignWorkflows, suitesOf } from '../src/workflows/registry.ts'
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
    expect(() => buildWorkflows([clash as never, ...elsewhere], deps, () => true)).toThrow(
      'served by another process and by clash/module.ts',
    )
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
