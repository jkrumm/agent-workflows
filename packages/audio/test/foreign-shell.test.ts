import { describe, expect, test } from 'bun:test'
import type { AnyWorkflow } from '@agent-workflows/runtime'
import { startFakeGateway } from '@agent-workflows/testing/gateway'
import { testDeps } from './support.ts'
import { postgresJournal } from '../src/workflows/podcast/history.ts'
import { createPodcastWorkflow, PODCAST_SHELL } from '../src/workflows/podcast/index.ts'
import podcastModule from '../src/workflows/podcast/module.ts'
import { fakeHistory, fakeRoom } from '../src/workflows/podcast/testing.ts'
import { createSpeechRoundtrip, SPEECH_ROUNDTRIP_SHELL } from '../src/workflows/speech-roundtrip/index.ts'
import speechModule from '../src/workflows/speech-roundtrip/module.ts'

// The host holds a workflow of the audio process by its shell (`foreign()`): id, version, schemas and scorer. The
// process builds its served workflow from the same object, so what the host starts and scores is what the process runs.

const SERVED_EXTRAS = ['run', 'concurrency']

function expectShellPlus(served: AnyWorkflow, shell: object) {
  for (const [key, value] of Object.entries(shell)) expect((served as Record<string, unknown>)[key]).toBe(value)
  const extra = Object.keys(served).filter((key) => !(key in shell))
  expect(extra.every((key) => SERVED_EXTRAS.includes(key))).toBe(true)
}

describe('the audio shells', () => {
  test('podcast: the served definition is the shell plus run and concurrency', () => {
    const served = createPodcastWorkflow({
      journal: postgresJournal({ query: async () => ({ rows: [] }) } as never, 'agw'),
      history: fakeHistory(),
      models: fakeRoom(),
      config: { hosts: [], agentic: false, voicePath: null } as never,
    })
    expectShellPlus(served, PODCAST_SHELL)
  })

  test('speech-roundtrip: the served definition is the shell plus run', () => {
    const iu = startFakeGateway()
    try {
      expectShellPlus(createSpeechRoundtrip({ audio: testDeps(iu) }).workflow, SPEECH_ROUNDTRIP_SHELL)
    } finally {
      iu.stop()
    }
  })

  test('the modules declare exactly their shell as the foreign workflow, with a body that refuses to run', async () => {
    for (const [module, shell] of [
      [podcastModule, PODCAST_SHELL],
      [speechModule, SPEECH_ROUNDTRIP_SHELL],
    ] as const) {
      const [foreign, ...rest] = module.foreign?.() ?? []
      expect(rest).toEqual([])
      expect(foreign).toBeDefined()
      expectShellPlus(foreign as AnyWorkflow, shell)
      expect(Object.keys(foreign as AnyWorkflow).filter((key) => !(key in shell))).toEqual(['run'])
      const refused = await (foreign as AnyWorkflow).run({} as never, {}).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(refused)).toContain('served by another process')
    }
  })
})
