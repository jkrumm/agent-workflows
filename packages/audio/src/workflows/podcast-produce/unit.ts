import { z } from 'zod'
import type { Ctx, Json, Usage } from '../../../../runtime/src/index.ts'
import { defineWorkflow } from '../../../../runtime/src/index.ts'
import { type AudioDeps, createAudioScope } from '../../scope.ts'
import { findUnit, type StoredUnit, storeUnit, unitRequestHash, usageToRecord } from './files.ts'
import { log } from './log.ts'
import type { UsagePort } from '../../usage.ts'
import { type SynthTurnInput, synthesizeUnit, type TtsLane } from './synth.ts'

// `podcast.produce.unit`: one synth unit as a child run of `podcast.produce`'s `synth` fan-out (`ctx.workflow`, one
// child per unit under one literal step id; concept §3). Internal. Its one step synthesizes the unit on a priced audio
// scope and stores the PCM in the artifact store before it ends; a done child replays from the journal on resume, and a
// child whose audio an interrupted attempt already stored reuses it (`files.ts`).

/** The children run in-process at once; this bounds their TTS requests (legacy: `TTS_CONCURRENCY`). */
export function limiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

const Turn = z.looseObject({
  text: z.string(),
  speaker: z.enum(['A', 'B']),
  speakerName: z.string(),
  voice: z.string(),
})

export const UnitInput = z.object({
  /** The episode: the artifact directory. */
  episodeId: z.string(),
  index: z.number().int().nonnegative(),
  lane: z.looseObject({ kind: z.enum(['gemini', 'replicate']), routeId: z.string() }),
  /** Each host's first turn in the script: the multi-speaker request's speaker labels and voices (legacy: whole script). */
  speakers: z.array(Turn).max(2),
  /** The unit's turns, in order. */
  turns: z.array(Turn).min(1),
})
export type UnitInputValue = z.output<typeof UnitInput>

export const UnitOutput = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  sampleRate: z.number(),
  audioSeconds: z.number(),
  inputChars: z.number(),
  reused: z.boolean(),
})

/** Each host's first turn: what legacy's `synthesizeGeminiUnits` read the speaker pair from. */
export function speakersOf(turns: SynthTurnInput[]): SynthTurnInput[] {
  return (['A', 'B'] as const).flatMap((id) => {
    const first = turns.find((t) => t.speaker === id)
    return first ? [first] : []
  })
}

export function createUnitWorkflow(deps: {
  audio: Omit<AudioDeps, 'usage'>
  dirOf: (episodeId: string) => string
  /** Test seam: called after the unit is stored, before its step ends. */
  onStored?: (file: StoredUnit) => Promise<void>
  /** The audio scope's usage sink for one step: its calls priced onto that step. */
  usage: (addUsage: (usage: Usage) => void) => UsagePort
}) {
  const limit = limiter(Math.max(1, deps.audio.config.ttsConcurrency))

  async function run(ctx: Ctx, input: UnitInputValue): Promise<StoredUnit> {
    return (await ctx.step('synth', (scope) =>
      limit(async () => {
        if (scope.signal.aborted) throw scope.signal.reason
        const lane = input.lane as unknown as TtsLane
        const speakers = input.speakers as unknown as SynthTurnInput[]
        const turns = input.turns as unknown as SynthTurnInput[]
        const dir = deps.dirOf(input.episodeId)
        const hash = unitRequestHash({ lane, speakers, turns })
        const found = await findUnit(dir, input.index, hash)
        if (found) {
          log.info('podcast unit audio found in the store, not synthesized again', {
            unit: input.index,
            key: scope.key,
          })
          // An earlier attempt of this step stored it and died before recording the usage: recorded here.
          for (const usage of usageToRecord(found.billed, scope.key)) scope.addUsage(usage)
          return found.unit as unknown as Json
        }
        const reported: Usage[] = []
        const audio = createAudioScope(
          {
            ...deps.audio,
            usage: deps.usage((usage) => {
              reported.push(usage)
              scope.addUsage(usage)
            }),
          },
          { requestId: scope.key, caller: 'podcast.produce' },
        )
        // The speakers lead the list so the request's labels are the script's; the unit's turns follow them.
        const out = await synthesizeUnit(audio, lane, [...speakers, ...turns], {
          turnIndexes: turns.map((_, i) => speakers.length + i),
        })
        scope.progress()
        const unit = await storeUnit(dir, input.index, hash, out, { producedBy: scope.key, usage: reported })
        await deps.onStored?.(unit)
        return unit as unknown as Json
      }),
    )) as unknown as StoredUnit
  }

  return defineWorkflow({
    id: 'podcast.produce.unit',
    version: '2026-10-29.1',
    input: UnitInput,
    output: UnitOutput,
    run,
  })
}
