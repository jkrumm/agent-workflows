import { z } from 'zod'
import { complete, type LlmDeps } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'

export const summarizeInput = z.object({
  text: z.string().min(1).describe('The text to summarize'),
  maxWords: z.int().min(10).max(1000).default(100).describe('Upper bound for the summary length'),
  style: z.enum(['paragraph', 'bullets']).default('paragraph').describe('Prose paragraph or a bullet list'),
})

export const summarizeOutput = z.object({ summary: z.string() })

const SYSTEM =
  'You summarize text faithfully. Keep what matters, drop what does not, add nothing the text does not say. ' +
  'Reply with the summary only: no preamble, no title, no commentary about the task.'

export const createSummarize = (deps: LlmDeps) =>
  defineCapability({
    id: 'llm.summarize',
    summary: 'Summarize a text with the cheap summarize route',
    input: summarizeInput,
    output: summarizeOutput,
    cli: { positional: ['text'], stdin: 'text', plainField: 'summary' },
    async handler({ text, maxWords, style }, ctx) {
      const shape = style === 'bullets' ? 'a short bullet list' : 'one paragraph'
      const { text: summary } = await complete(deps, {
        routeId: 'cheap.summarize',
        system: SYSTEM,
        prompt: `Summarize the text below as ${shape} of at most ${maxWords} words.\n\n<text>\n${text}\n</text>`,
        ctx,
      })
      return { summary }
    },
  })
