import { z } from 'zod'
import { Host, Language, Profile, Segment } from './schema.ts'

// The input of `podcast.produce`, the internal child the writers' room hands its locked script to (synth, master,
// cover, publish, brain note). Exactly what audio-gateway's stages after scripting read (`runPodcastPipeline` from
// step 4 on, `publishEpisode`, `writeEpisodeBrainNote`, `renderTranscriptMarkdown`): from `script.json`, from the job
// state, and from the request. Nothing here is computed by the produce stage's caller beyond what legacy persisted.

export const ProduceInput = z.object({
  /** The episode's identity: legacy's job id and `createdAt` (file names, the brain note's `job` and date). */
  episode: z.object({
    /** The `podcast` run id. */
    id: z.string(),
    /** ISO timestamp of the run's start. */
    createdAt: z.string(),
  }),
  /** The locked script (legacy `script.json` minus the metadata fields, which travel in `metadata`). */
  script: z.object({
    language: Language,
    /** Chapter titles from the metadata pass already applied: one chapter per segment. */
    segments: z.array(Segment).min(1),
    wordCount: z.number(),
    /** The listener asks and the segment that owns each. */
    asks: z.array(z.object({ ask: z.string(), segmentIndex: z.number() })).optional(),
    /** What the opening was checked against. */
    openingFrame: z.array(z.string()).optional(),
  }),
  /** The two hosts in speaker order: display names for the transcript, voices and speeds for the synth. */
  hosts: z.tuple([Host, Host]),
  /** The metadata pass's result (outline drafts where it left a field blank). */
  metadata: z.object({
    title: z.string(),
    /** 2-4 sentences, show-notes style: the MP3 comment, the Audiobookshelf description, the brain note. */
    description: z.string(),
    /** English, for the cover image model. */
    coverPrompt: z.string(),
    /** The first is the MP3 genre tag. */
    genres: z.array(z.string()),
    topics: z.array(z.string()),
  }),
  /** The request fields the later stages read. */
  request: z.object({
    /** The Audiobookshelf show and the MP3 album; the brain note's series tag; the track number counts its episodes. */
    series: z.string(),
    language: Language,
    /** Requested minutes. */
    minutes: z.number(),
    publish: z.boolean(),
    cover: z.boolean(),
    brainNote: z.boolean(),
  }),
  /** The episode profile at script lock; the produce stage fills `durationSeconds` (and `segmentation`) and writes it into the brain note's frontmatter. */
  profile: Profile,
})
export type ProduceInputValue = z.output<typeof ProduceInput>
