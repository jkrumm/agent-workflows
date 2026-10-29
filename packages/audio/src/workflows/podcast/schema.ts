import { z } from 'zod'

// The `podcast` workflow's input (audio-gateway's `POST /v1/podcasts` body, same clamps) and output, and the shared
// shapes of a script. Legacy coerced a wrong-typed flag to its default; here a wrong type is a typed `invalid_input`.

/** audio-gateway `podcasts.ts`: MAX_SOURCE_CHARS, MIN_MINUTES, MAX_MINUTES; `config.ts`: the defaults. */
export const MAX_SOURCE_CHARS = 200_000
export const MIN_MINUTES = 3
export const MAX_MINUTES = 60
export const DEFAULT_MINUTES = 20
export const MAX_SOURCE_PATHS = 20
export const DEFAULT_SERIES = 'Brain Sonderausgabe'

export const Language = z.enum(['de', 'en'])

export const PodcastInput = z
  .object({
    source: z
      .string()
      .max(MAX_SOURCE_CHARS)
      .default('')
      .describe('The notes the episode is about; may be blank when sourcePaths name notes'),
    sourcePaths: z
      .array(z.string().refine((p) => p.trim().length > 0, 'a source path must not be blank'))
      .max(MAX_SOURCE_PATHS)
      .default([])
      .describe('Vault-relative note paths, read in-process and appended to the source'),
    brief: z.string().optional().describe('Who the listener is and what they want from this episode'),
    title: z.string().optional().describe('A title hint; the metadata pass decides the final title'),
    language: Language.default('de'),
    minutes: z
      .number()
      .default(DEFAULT_MINUTES)
      .transform((m) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m)))
      .describe(`Requested length, clamped to ${MIN_MINUTES}..${MAX_MINUTES}`),
    series: z
      .string()
      .default('')
      .transform((s) => s.trim() || DEFAULT_SERIES)
      .describe('The show (Audiobookshelf podcast) this episode belongs to'),
    publish: z.boolean().default(false).describe('Publish to Audiobookshelf'),
    cover: z.boolean().default(true).describe('Generate and embed a cover'),
    research: z.boolean().default(true).describe('Run the research stage'),
    pinMinutes: z.boolean().default(false).describe('The editor may not deviate from minutes'),
    brainNote: z.boolean().default(true).describe('Write the transcript note back into the vault'),
  })
  .strict()
  .refine((input) => input.source.trim().length > 0 || input.sourcePaths.length > 0, {
    message: 'source or sourcePaths is required',
  })
export type PodcastRequest = z.output<typeof PodcastInput>

export const Speaker = z.enum(['A', 'B'])

export const Turn = z.object({
  speaker: Speaker,
  text: z.string(),
  /** A delivery key where the moment changes; absent = the host's baseline. */
  delivery: z.string().optional(),
})

export const Segment = z.object({ title: z.string(), turns: z.array(Turn) })

export const Host = z.object({
  id: Speaker,
  name: z.string(),
  /** The synth voice, as the produce stage's TTS lane names it. */
  voice: z.string(),
  /** ElevenLabs-lane speed (0.7..1.2); absent = the voice's own pace. */
  speed: z.number().optional(),
})
export type HostValue = z.output<typeof Host>

/** What the show remembers per episode (legacy `EpisodeProfile`); `durationSeconds` is filled by the produce stage. */
export const Profile = z.object({
  format: z.string(),
  lead: z.enum(['A', 'B', 'balanced']),
  humor: z.enum(['none', 'sparse', 'natural']),
  opening: z.string(),
  minutes: z.number(),
  durationSeconds: z.number().nullable(),
  topics: z.array(z.string()),
  segmentCount: z.number(),
  toolCalls: z.number(),
  researchCalls: z.number(),
  researchUsd: z.number().optional(),
  expression: z
    .object({ tags: z.number(), deliveries: z.number(), findings: z.record(z.string(), z.number()) })
    .optional(),
  agent: z.object({ runs: z.number(), rounds: z.number(), rejections: z.number(), fellBack: z.number() }).optional(),
  requestedMinutes: z.number().optional(),
  words: z.number().optional(),
  lengthVsRequested: z.number().optional(),
  lengthShort: z.boolean().optional(),
  asks: z
    .object({ total: z.number(), uncovered: z.number().nullable(), openingFramed: z.boolean().nullable() })
    .optional(),
  segmentation: z
    .object({
      units: z.number(),
      minChars: z.number(),
      meanChars: z.number(),
      maxChars: z.number(),
      findings: z.array(z.string()),
    })
    .optional(),
})

export const Chapter = z.object({ title: z.string(), startMs: z.number().optional() })

/** What the room reads back from `podcast.produce`'s output; everything else it returns is passed through as is. */
export const ProduceResult = z.looseObject({
  durationSeconds: z.number().nullable().optional(),
  chapters: z.array(z.object({ title: z.string(), startMs: z.number() })).optional(),
})

export const PodcastOutput = z.object({
  title: z.string(),
  description: z.string(),
  /** With start times when the produce stage ran, else the chapter titles alone. */
  chapters: z.array(Chapter),
  profile: Profile,
  /**
   * Read from the journal's step records, never summed in memory: retries, failed attempts and resumed steps are in it.
   * A call without a price counts as unpriced; above 0, the matching USD is a lower bound.
   */
  cost: z.object({
    /** Every model call of the room (the research loop included). */
    scriptUsd: z.number(),
    scriptUnpriced: z.number(),
    /** The host `research` runs this episode started, found by their idempotency key. */
    researchUsd: z.number(),
    researchUnpriced: z.number(),
    researchRuns: z.number(),
    /** The `podcast.produce` child. */
    produceUsd: z.number(),
    produceUnpriced: z.number(),
    totalUsd: z.number(),
    unpriced: z.number(),
  }),
  /** `podcast.produce`'s output; null when no produce workflow is wired (the writers' room ran alone). */
  produce: ProduceResult.nullable(),
})
export type PodcastResult = z.output<typeof PodcastOutput>
