import { join } from 'node:path'
import type { HostDeps } from '../../../../host/src/workflows/index.ts'
import { defineWorkflowModule, foreignOf } from '../../../../host/src/workflows/registry.ts'
import { plainSuite } from '../../../../host/src/workflows/suite.ts'
import type { AudioDeps } from '../../scope.ts'
import { createSpeechRoundtrip, SPEECH_ROUNDTRIP_SHELL } from './index.ts'

/** What the audio process adds to `HostDeps` for this module. */
type SpeechRoundtripDeps = HostDeps & { audio?: Omit<AudioDeps, 'usage'> }

/** Six committed sentences (`PlainCase` lines): three English, three German, one with numbers. */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

export default defineWorkflowModule({
  id: 'speech-roundtrip',
  create(deps) {
    const { audio } = deps as SpeechRoundtripDeps
    if (!audio) throw new Error("speech-roundtrip module: the process must pass `audio` (the lanes' deps) in its deps")
    return [createSpeechRoundtrip({ audio })]
  },
  foreign: () => [foreignOf(SPEECH_ROUNDTRIP_SHELL)],
  suite: { path: () => CASES_PATH, read: (path) => plainSuite.read(path) },
})
