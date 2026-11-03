import { z } from 'zod'
import { foreignOf } from '../../../src/workflows/registry.ts'

/** A foreign workflow of `id` with a scorer, as an audio module would declare it. */
export const farWorkflow = (id: string) =>
  foreignOf({
    id,
    version: 'v1',
    input: z.object({}),
    output: z.object({}),
    scorer: { version: 'far-scorer-1', score: () => ({ scores: { ok: 1 }, pass: true }) },
  })
