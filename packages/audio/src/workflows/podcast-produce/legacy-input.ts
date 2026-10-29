import { ProduceInput, type ProduceInputValue } from '../podcast/produce-input.ts'

// `podcast.produce`'s input from a recorded audio-gateway job (`script.json`, the ledger row's request and state), for
// `scripts/produce-from-legacy.ts`: production alone on a real script. The same hand-off the room makes (`podcast`
// step 11).

export interface LegacyScript {
  title: string
  description: string
  coverPrompt: string
  genres: string[]
  topics?: string[]
  language: 'de' | 'en'
  segments: ProduceInputValue['script']['segments']
  wordCount: number
  asks?: { ask: string; segmentIndex: number }[]
  openingFrame?: string[]
  hosts: ProduceInputValue['hosts']
}

export interface LegacyRequest {
  series: string
  language: 'de' | 'en'
  minutes: number
  cover?: boolean
}

export interface LegacyState {
  profile: ProduceInputValue['profile'] | null
}

export interface BuildFlags {
  publish: boolean
  brainNote: boolean
  cover: boolean
}

/** The room's hand-off, from what legacy persisted. Pure. */
export function produceInputFromLegacy(params: {
  job: { id: string; createdAt: string }
  script: LegacyScript
  request: LegacyRequest
  state: LegacyState
  flags: BuildFlags
}): ProduceInputValue {
  const { job, script, request, state, flags } = params
  if (!state.profile) throw new Error(`legacy job ${job.id} has no profile (older than the profile)`)
  return ProduceInput.parse({
    episode: { id: job.id, createdAt: job.createdAt },
    script: {
      language: script.language,
      segments: script.segments,
      wordCount: script.wordCount,
      ...(script.asks ? { asks: script.asks } : {}),
      ...(script.openingFrame ? { openingFrame: script.openingFrame } : {}),
    },
    hosts: script.hosts,
    metadata: {
      title: script.title,
      description: script.description,
      coverPrompt: script.coverPrompt,
      genres: script.genres,
      topics: script.topics ?? [],
    },
    request: {
      series: request.series,
      language: request.language,
      minutes: request.minutes,
      publish: flags.publish,
      cover: flags.cover && request.cover !== false,
      brainNote: flags.brainNote,
    },
    // Production fills these again; a recorded value would be the legacy episode's.
    profile: { ...state.profile, durationSeconds: null, segmentation: undefined },
  })
}
