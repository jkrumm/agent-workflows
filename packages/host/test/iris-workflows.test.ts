// The two Iris replay workflows call the capability Iris calls, with the input Iris sends and nothing else: an eval of
// another call would measure the wrong thing. Run on a fake registry that records what it is asked.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Runtime } from '@agent-workflows/runtime'
import { freshSchema, inspector, testRuntime } from '@agent-workflows/testing/pg'
import { createIrisGist } from '../src/workflows/iris-gist/index.ts'
import { createIrisTriage } from '../src/workflows/iris-triage/index.ts'

const db = freshSchema('iriswf')
const sql = inspector(db.schema)

const calls: { id: string; input: unknown }[] = []
const registry = {
  call: async (id: string, input: unknown) => {
    calls.push({ id, input })
    return id === 'triage'
      ? {
          headline: 'Deploy geprüft',
          detail: 'Der Deploy ist grün.',
          spoken: 'Der Deploy ist grün.',
          model: 'm',
          attempts: 1,
          latencyMs: 1234,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 },
        }
      : { summary: 'Ein Satz.' }
  },
} as never

const triage = createIrisTriage({ registry })
const gist = createIrisGist({ registry })
let rt: Runtime

beforeAll(async () => {
  rt = testRuntime({ schema: db.schema, workflows: [triage.workflow, gist.workflow] })
  await rt.open()
})
afterAll(async () => {
  await rt.close()
  await sql.close()
  await db.drop()
})

describe('the replay workflows', () => {
  test('iris-triage calls triage with the memo as given and returns the notification, the call and its latency, not the usage', async () => {
    const input = { destination: 'hermes', transcript: 'Bitte den Deploy prüfen.', reply: 'Grün.' }
    const { runId } = await rt.start(triage.workflow, input, { purpose: 'eval' })
    const end = await rt.wait(runId)
    expect(end.error).toBeNull()
    expect(calls.at(-1)).toEqual({ id: 'triage', input })
    expect(end.output).toEqual({
      headline: 'Deploy geprüft',
      detail: 'Der Deploy ist grün.',
      spoken: 'Der Deploy ist grün.',
      model: 'm',
      attempts: 1,
      latencyMs: 1234,
    })
  })

  test('iris-gist calls llm.summarize as a paragraph with the recorded word bound, 30 by default', async () => {
    const { runId } = await rt.start(gist.workflow, { text: 'Ein langes Diktat.' }, { purpose: 'eval' })
    const end = await rt.wait(runId)
    expect(end.error).toBeNull()
    expect(calls.at(-1)).toEqual({
      id: 'llm.summarize',
      input: { text: 'Ein langes Diktat.', maxWords: 30, style: 'paragraph' },
    })
    expect(end.output).toEqual({ summary: 'Ein Satz.' })

    const other = await rt.start(gist.workflow, { text: 'x', maxWords: 12 }, { purpose: 'eval' })
    await rt.wait(other.runId)
    expect(calls.at(-1)?.input).toMatchObject({ maxWords: 12 })
  })

  test('both are eval-only: neither has a command or a route', () => {
    expect(triage.internal).toBe(true)
    expect(gist.internal).toBe(true)
  })
})
