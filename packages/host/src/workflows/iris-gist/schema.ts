import { z } from 'zod'

/** Iris's gist call: the whole transcript and the word bound (30). The style is always a paragraph. */
export const IrisGistInput = z.object({
  text: z.string().min(1),
  maxWords: z.int().min(10).max(1000).default(30),
})
export type IrisGistInput = z.output<typeof IrisGistInput>

export const IrisGistOutput = z.object({ summary: z.string() })
export type IrisGistOutput = z.output<typeof IrisGistOutput>
